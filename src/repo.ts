/**
 * Repo: one Durable Object per artifact. Its SQLite holds a whole Fossil
 * repository (go-libfossil's tables, via src/fossil.ts) plus one row of
 * artifact metadata and the hashes of its three link tokens.
 */

import { DurableObject } from 'cloudflare:workers';
import { run, type FossilReply, type FossilRequest } from './fossil';
import { genToken, sha256hex, timingSafeEqual } from './util';
import { WAKE_FANOUT, ticketKind, type WakeKind } from './wake';

/** A ticket change a push stored: its ticket, its artifact hash, who made it and what it was. */
export interface PushedTicket {
  ticket: string;
  change: string;
  author: string;
  kind: WakeKind;
}

interface TicketChange {
  artifact: string;
  user: string;
  fields?: Record<string, string>;
}

/** Each role can do everything the ones before it can. */
export type Role = 'read' | 'comment' | 'write';
const RANK: Record<Role, number> = { read: 0, comment: 1, write: 2 };

/** Who is asking: the owner (bearer token), or the holder of a link token. */
export interface Caller {
  owner: boolean;
  token: string;
  /** Registry-authorized account access; never derived from client JSON. */
  permission?: Role;
}

export interface CreateArgs {
  id: string;
  title: string;
  user: string;
  message: string;
  files: Record<string, string>; // path -> base64
  expiresAt: number | null;      // unix seconds
  readToken: string;
  writeToken: string;
}

export interface Meta {
  id: string;
  title: string;
  createdAt: number;
  expiresAt: number | null;
}

/** The ops a caller may run, by the role they need. */
const NEEDS: Record<string, Role> = {
  tip: 'read', info: 'read', bundle: 'read', preview: 'read', raw: 'read', uvGet: 'read', uvList: 'read',
  ticketThreads: 'read', ticketChanges: 'read', timelineSince: 'read', attachList: 'read', attachRead: 'read',
  ticketAdd: 'comment', ticketSet: 'comment', attachAdd: 'comment', attachAddExternal: 'comment', attachDelete: 'comment',
  commit: 'write', uvSet: 'write',
};

export class Repo extends DurableObject<Env> {
  /** Set once the table and its columns are known to be current; a Durable Object's schema only changes on deploy. */
  private tableReady = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Fossil runs with foreign keys off. The pragma lasts for the connection
    // but is ignored inside a transaction, and every write in a call opens
    // one, so set it here before anything else runs.
    ctx.storage.sql.exec('PRAGMA foreign_keys = OFF');
  }

  private meta(): (Meta & { readHash: string; writeHash: string; commentHash: string }) | null {
    const rows = this.ctx.storage.sql
      .exec<{ id: string; title: string; created_at: number; expires_at: number | null; read_hash: string; write_hash: string; comment_hash: string }>(
        `SELECT * FROM _artifact LIMIT 1`,
      )
      .toArray();
    const r = rows[0];
    if (!r || (r.expires_at != null && r.expires_at <= Date.now() / 1000)) return null;
    return {
      id: r.id, title: r.title, createdAt: r.created_at, expiresAt: r.expires_at,
      readHash: r.read_hash, writeHash: r.write_hash, commentHash: r.comment_hash,
    };
  }

  private ensureTable(): void {
    if (this.tableReady) return;
    const sql = this.ctx.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS _artifact (
      id TEXT NOT NULL, title TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER,
      read_hash TEXT NOT NULL, write_hash TEXT NOT NULL,
      read_token TEXT NOT NULL DEFAULT '',
      comment_hash TEXT NOT NULL DEFAULT '', comment_token TEXT NOT NULL DEFAULT '')`);
    // Artifacts made before comment links have no comment token until an editor asks for one.
    if (!sql.exec<{ name: string }>('PRAGMA table_info(_artifact)').toArray().some(c => c.name === 'comment_hash')) {
      sql.exec(`ALTER TABLE _artifact ADD COLUMN comment_hash TEXT NOT NULL DEFAULT ''`);
      sql.exec(`ALTER TABLE _artifact ADD COLUMN comment_token TEXT NOT NULL DEFAULT ''`);
    }
    this.tableReady = true;
  }

  /** Create the repository and its first check-in. */
  async create(args: CreateArgs): Promise<FossilReply<{ tip: string }>> {
    this.ensureTable();
    if (this.ctx.storage.sql.exec(`SELECT 1 FROM _artifact`).toArray().length) {
      return { error: 'artifact already exists', code: 'conflict' };
    }
    const reply = run<{ tip: string }>(this.ctx.storage, {
      op: 'create', projectName: args.title, user: args.user, comment: args.message,
      files: args.files, readToken: args.readToken, writeToken: args.writeToken,
    });
    if (!reply.ok) return reply;
    this.ctx.storage.sql.exec(
      `INSERT INTO _artifact (id, title, created_at, expires_at, read_hash, write_hash, read_token) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args.id, args.title, Math.floor(Date.now() / 1000), args.expiresAt,
      await sha256hex(args.readToken), await sha256hex(args.writeToken),
      // Kept so editors can share the read link; the write token is never stored.
      args.readToken,
    );
    if (args.expiresAt != null) await this.ctx.storage.setAlarm(args.expiresAt * 1000);
    return reply;
  }

  /** The role `caller` holds on this artifact, or null for none. */
  async role(caller: Caller): Promise<Role | null> {
    this.ensureTable();
    const m = this.meta();
    if (!m) return null;
    if (caller.owner) return 'write';
    if (caller.permission) return caller.permission;
    if (!caller.token) return null;
    const h = await sha256hex(caller.token);
    if (timingSafeEqual(h, m.writeHash)) return 'write';
    if (m.commentHash && timingSafeEqual(h, m.commentHash)) return 'comment';
    if (timingSafeEqual(h, m.readHash)) return 'read';
    return null;
  }

  /** Run one Fossil op for `caller`. Unknown, expired and forbidden all answer not_found. */
  async op(caller: Caller, request: FossilRequest): Promise<FossilReply<unknown>> {
    const need = NEEDS[request.op];
    const role = await this.role(caller);
    if (!need || !role) return { error: 'not found', code: 'not_found' };
    if (RANK[role] < RANK[need]) {
      return { error: role === 'read' ? 'this link is read-only' : 'this link can only comment', code: 'forbidden' };
    }
    return run<unknown>(this.ctx.storage, request);
  }

  /**
   * Fossil's sync protocol; the repository's own logins decide access. When
   * the request stored artifacts (a push), the result also lists the ticket
   * changes among them, so the Worker can wake for each.
   */
  async sync(body: Uint8Array, cookie: string): Promise<FossilReply<{ data: string; tickets?: PushedTicket[] }>> {
    this.ensureTable();
    if (!this.meta()) return { error: 'not found', code: 'not_found' };
    // No await from here to the return: the object runs no other request in
    // between, so `before` is exactly the last artifact stored before this one.
    const before = this.lastArrived();
    const r = run<{ data: string }>(this.ctx.storage, { op: 'sync', cookie }, body);
    if (!r.ok || !r.result || !before || this.lastArrived() === before) return r;
    return { ...r, result: { ...r.result, tickets: this.ticketsSince(before) } };
  }

  /**
   * The artifact this repository stored last, in the arrival order
   * timelineSince uses: by receipt, then rid. Phantoms have not arrived.
   */
  private lastArrived(): string | null {
    return this.ctx.storage.sql.exec<{ uuid: string }>(
      'SELECT uuid FROM blob WHERE size >= 0 ORDER BY coalesce(rcvid, 0) DESC, rid DESC LIMIT 1',
    ).toArray()[0]?.uuid ?? null;
  }

  /** The ticket changes that arrived after `hash`, oldest first, at most WAKE_FANOUT. */
  private ticketsSince(hash: string): PushedTicket[] {
    const since = run<{ uuid: string }[]>(this.ctx.storage, { op: 'timelineSince', hash, types: ['t'] });
    const entries = since.ok ? since.result ?? [] : [];
    if (entries.length > WAKE_FANOUT) {
      console.warn(`wake: a sync stored ${entries.length} ticket changes; waking for the newest ${WAKE_FANOUT}`);
    }
    const threads = new Map<string, TicketChange[]>();
    const out: PushedTicket[] = [];
    for (const { uuid: change } of entries.slice(0, WAKE_FANOUT).reverse()) {
      // A ticket change carries its ticket's id as the tkt-<id> tag.
      const ticket = this.ctx.storage.sql.exec<{ id: string }>(
        `SELECT substr(tag.tagname, 5) AS id FROM blob JOIN tagxref ON tagxref.rid = blob.rid
         JOIN tag ON tag.tagid = tagxref.tagid WHERE blob.uuid = ? AND tag.tagname GLOB 'tkt-*' LIMIT 1`, change,
      ).toArray()[0]?.id;
      if (!ticket) continue;
      if (!threads.has(ticket)) {
        const r = run<TicketChange[]>(this.ctx.storage, { op: 'ticketChanges', ticketUuid: ticket });
        threads.set(ticket, r.ok ? r.result ?? [] : []);
      }
      const changes = threads.get(ticket)!;
      const i = changes.findIndex(c => c.artifact === change);
      if (i < 0) continue;
      out.push({ ticket, change, author: changes[i]!.user, kind: ticketKind(i === 0, changes[i]!.fields ?? {}) });
    }
    return out;
  }

  async info(): Promise<Meta | null> {
    this.ensureTable();
    const m = this.meta();
    return m && { id: m.id, title: m.title, createdAt: m.createdAt, expiresAt: m.expiresAt };
  }

  /** The read token, for a caller who may share it (an editor). */
  async readToken(caller: Caller): Promise<string | null> {
    if (caller.permission || (await this.role(caller)) !== 'write') return null;
    return this.ctx.storage.sql.exec<{ read_token: string }>(`SELECT read_token FROM _artifact`).toArray()[0]?.read_token ?? null;
  }

  /**
   * The comment token, for a caller who may share it (an editor, by link or
   * account). An artifact made before comment links gets one on the first such
   * request.
   */
  async commentToken(caller: Caller): Promise<string | null> {
    if ((await this.role(caller)) !== 'write') return null;
    const sql = this.ctx.storage.sql;
    const stored = () => sql.exec<{ comment_token: string }>(`SELECT comment_token FROM _artifact`).toArray()[0]?.comment_token ?? '';
    if (stored()) return stored();
    const token = genToken();
    const hash = await sha256hex(token);
    // Another request may have minted one while this one hashed; the first stays.
    sql.exec(`UPDATE _artifact SET comment_hash = ?, comment_token = ? WHERE comment_token = ''`, hash, token);
    return stored();
  }

  async rename(title: string): Promise<void> {
    this.ctx.storage.sql.exec(`UPDATE _artifact SET title = ?`, title);
  }

  async destroy(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  /** Expiry. */
  async alarm(): Promise<void> {
    this.ensureTable();
    const id = this.ctx.storage.sql.exec<{ id: string }>(`SELECT id FROM _artifact`).toArray()[0]?.id;
    await this.destroy();
    if (id) await this.env.REGISTRY.getByName('registry').remove(id);
  }
}
