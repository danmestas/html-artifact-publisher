/**
 * Repo: one Durable Object per artifact. Its SQLite holds a whole Fossil
 * repository (go-libfossil's tables, via src/fossil.ts) plus one row of
 * artifact metadata and the hashes of its three link tokens.
 */

import { DurableObject } from 'cloudflare:workers';
import { run, type FossilReply, type FossilRequest } from './fossil';
import { b64encode, genToken, sha256hex, timingSafeEqual } from './util';
import { WAKE_FANOUT, ticketKind, type WakeKind } from './wake';
import { RESPONDER_STATUS_FILE, applyStatus, resolveChange, statusFrom, type StatusRequest } from './responder-status';

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
  ticketThreads: 'read', ticketChanges: 'read', timelineSince: 'read', attachList: 'read', attachRead: 'read', attachExternals: 'read',
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
    // A Durable Object may be evicted between calls while its storage lives
    // on, so a cached "ready" is only trusted while the table is really there.
    if (this.tableReady) { try { this.ctx.storage.sql.exec(`SELECT 1 FROM _artifact LIMIT 0`); return; } catch { /* rebuilt below */ } }
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
    // Expiration is this object's authority; the revision names the newest
    // intent so a stale Registry projection can never overwrite a newer one.
    const artifactCols = sql.exec<{ name: string }>('PRAGMA table_info(_artifact)').toArray().map(c => c.name);
    if (!artifactCols.includes('expiration_revision')) sql.exec(`ALTER TABLE _artifact ADD COLUMN expiration_revision INTEGER NOT NULL DEFAULT 0`);
    if (!artifactCols.includes('projected_revision')) sql.exec(`ALTER TABLE _artifact ADD COLUMN projected_revision INTEGER NOT NULL DEFAULT 0`);
    if (!artifactCols.includes('pending_actor')) sql.exec(`ALTER TABLE _artifact ADD COLUMN pending_actor TEXT`);
    if (!artifactCols.includes('pending_title')) sql.exec(`ALTER TABLE _artifact ADD COLUMN pending_title TEXT`);
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

  /**
   * Record the responder's status for the thread holding change `req.change`
   * (a hash prefix), for a write-capable caller. No await once the role is
   * known, so no other request reads or writes the file in between.
   */
  async responderStatus(caller: Caller, req: StatusRequest): Promise<FossilReply<{ ticketUuid: string }>> {
    const role = await this.role(caller);
    if (!role) return { error: 'not found', code: 'not_found' };
    if (role !== 'write') return { error: 'the edit link is required to set the responder status', code: 'forbidden' };
    const listed = run<{ tickets: { uuid: string; changes: { artifact: string }[] }[] }>(this.ctx.storage, { op: 'ticketThreads', limit: 200 });
    if (!listed.ok || !listed.result) return { error: listed.error, code: listed.code };
    const found = resolveChange(listed.result.tickets, req.change);
    if (found === 'none') return { error: 'no such change', code: 'not_found' };
    if (found === 'many') return { error: 'the change prefix matches more than one thread', code: 'conflict' };
    const stored = run<{ data: string | null }>(this.ctx.storage, { op: 'uvGet', name: RESPONDER_STATUS_FILE });
    const file = applyStatus(statusFrom(stored.ok ? stored.result?.data : null), found.ticketUuid, found.change, req.state, req.step, new Date().toISOString());
    const data = b64encode(new TextEncoder().encode(JSON.stringify(file)));
    const written = run<unknown>(this.ctx.storage, { op: 'uvSet', name: RESPONDER_STATUS_FILE, data });
    if (!written.ok) return { error: written.error, code: written.code };
    return { ok: true, result: { ticketUuid: found.ticketUuid } };
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

  /**
   * Replace the comment token, for an editor cutting off a leaked comment
   * link. The old token stops working at once; read and edit links are kept.
   */
  async rotateCommentToken(caller: Caller): Promise<string | null> {
    if ((await this.role(caller)) !== 'write') return null;
    const token = genToken();
    const hash = await sha256hex(token);
    this.ctx.storage.sql.exec(`UPDATE _artifact SET comment_hash = ?, comment_token = ?`, hash, token);
    return token;
  }

  async rename(title: string): Promise<void> {
    this.ctx.storage.sql.exec(`UPDATE _artifact SET title = ?`, title);
  }

  /**
   * Store a new expiration (unix seconds, or null for none) and make the
   * alarm agree. The Repo is the authority: the deadline and the revision
   * that names this intent are written here first, so a failed Registry
   * projection loses nothing and is retried by this object's own alarm.
   */
  async setExpiration(expiresAt: number | null, actor: string, title: string | null): Promise<{ projected: boolean; found: boolean }> {
    // Test-only: hold the call after it was authorized but before it looks at
    // the row, so a request can cross the deadline. Unset in production.
    const env = this.env as unknown as Record<string, string | undefined>;
    if (env.TEST_EXPIRATION_SETTLE_MS) await new Promise(resolve => setTimeout(resolve, Number(env.TEST_EXPIRATION_SETTLE_MS)));
    // After the wait, not before: the alarm may have destroyed this repository
    // meanwhile, and the table has to exist before it can be asked about.
    this.ensureTable();
    const now = Math.floor(Date.now() / 1000);
    const revision = this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      const row = sql.exec<{ expiration_revision: number; expires_at: number | null }>(`SELECT expiration_revision, expires_at FROM _artifact LIMIT 1`).toArray()[0];
      if (!row) return null;
      // A request authorized before the deadline can arrive after it, ahead of
      // the alarm that destroys this repository. Writing then would revive an
      // expired artifact, so the row is checked for expiry in the same
      // transaction that would change it.
      if (row.expires_at != null && row.expires_at <= now) return null;
      sql.exec(`UPDATE _artifact SET expires_at = ?, expiration_revision = expiration_revision + 1, pending_actor = ?, pending_title = ?`, expiresAt, actor, title);
      return row.expiration_revision + 1;
    });
    if (revision == null) return { projected: false, found: false };
    // Arm the wake before the external call: if this isolate dies while the
    // Registry is being asked, the durable intent still has an alarm to retry
    // it. Re-evaluated after the answer so a confirmed ack cancels the retry.
    await this.scheduleAlarm();
    // Test-only: die here, after the intent is durable and the alarm is armed,
    // but before the Registry is ever asked. Convergence must then come from
    // the Repo's own alarm alone; with a wake armed only after the projection
    // this leaves nothing to run. Unset in production.
    if ((this.env as unknown as Record<string, string | undefined>).TEST_EXPIRATION_FAULT === 'crash-before-projection') {
      throw new Error('injected crash before projection');
    }
    const projected = await this.project(revision);
    await this.scheduleAlarm();
    return { projected, found: true };
  }

  /** How often a pending Registry projection is retried (ms). */
  private retryMs(): number {
    return Number((this.env as unknown as Record<string, string | undefined>).TEST_EXPIRATION_RETRY_MS || 0) || 2000;
  }

  /**
   * Test-only view of the durability state: whether an intent is still owed to
   * the Registry, and when the one alarm will next run. Blank in production;
   * wrangler.jsonc and deploy.sh blank the flag that reaches it.
   */
  async expirationState(): Promise<{ pending: boolean; alarmAt: number | null }> {
    this.ensureTable();
    if (!this.ctx.storage.sql.exec(`SELECT 1 FROM _artifact`).toArray().length) return { pending: false, alarmAt: null };
    return { pending: this.pending(), alarmAt: await this.ctx.storage.getAlarm() };
  }

  /**
   * Push the current desired deadline to the Registry. Only the revision that
   * is still current is acknowledged, so an older call can never clear a newer
   * intent; a retry of the same revision is idempotent.
   */
  private async project(revision: number): Promise<boolean> {
    const row = this.ctx.storage.sql
      .exec<{ id: string; expires_at: number | null; pending_actor: string | null; pending_title: string | null }>(
        `SELECT id, expires_at, pending_actor, pending_title FROM _artifact LIMIT 1`,
      ).toArray()[0];
    if (!row) return false;
    // Test-only: widen the window between reading this intent and projecting
    // it, so an older call can be made to arrive after a newer one. Unset in
    // production; wrangler.jsonc declares it blank and deploy.sh blanks it.
    const env = this.env as unknown as Record<string, string | undefined>;
    if (env.TEST_EXPIRATION_HOLD_REVISION === String(revision)) {
      await new Promise(resolve => setTimeout(resolve, Number(env.TEST_EXPIRATION_HOLD_MS) || 1000));
    }
    let outcome: 'applied' | 'stale' | 'missing';
    try {
      outcome = await this.env.REGISTRY.getByName('registry').projectExpiration({
        id: row.id, expiresAt: row.expires_at, revision, actor: row.pending_actor ?? '', title: row.pending_title,
      });
    } catch {
      // The Registry could not be reached: the intent stays pending here and
      // the alarm retries it. The caller is told the projection is unconfirmed.
      return false;
    }
    if (outcome === 'missing') {
      // Nothing to project to: the artifact is gone from the library, so the
      // intent is moot and must not wake this object forever.
      this.ctx.storage.sql.exec(`UPDATE _artifact SET projected_revision = expiration_revision WHERE expiration_revision <= ?`, revision);
      return true;
    }
    if (outcome === 'applied') {
      // Clear only if this is still the newest intent; a newer one stays pending.
      this.ctx.storage.sql.exec(`UPDATE _artifact SET projected_revision = ? WHERE expiration_revision = ?`, revision, revision);
      return true;
    }
    // Refused as stale: a newer intent has superseded this one. If that newer
    // intent is already projected, the two stores agree and nothing is pending.
    return !this.pending();
  }

  private pending(): boolean {
    const row = this.ctx.storage.sql
      .exec<{ expiration_revision: number; projected_revision: number }>(`SELECT expiration_revision, projected_revision FROM _artifact LIMIT 1`)
      .toArray()[0];
    return !!row && row.projected_revision < row.expiration_revision;
  }

  /** Arm the one alarm at the earliest of the deadline and any retry it owes. */
  private async scheduleAlarm(): Promise<void> {
    this.ensureTable();
    const row = this.ctx.storage.sql
      .exec<{ expires_at: number | null }>(`SELECT expires_at FROM _artifact LIMIT 1`).toArray()[0];
    if (!row) { await this.ctx.storage.deleteAlarm(); return; }
    const times: number[] = [];
    if (row.expires_at != null) times.push(row.expires_at * 1000);
    if (this.pending()) times.push(Date.now() + this.retryMs());
    if (!times.length) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(Math.min(...times));
  }

  async destroy(): Promise<void> {
    // The table goes with the storage, so a call that arrives afterwards must
    // build it again and find no row rather than query a missing table.
    this.tableReady = false;
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  /**
   * Expiry and projected-intent retry share the one alarm. The row is the
   * truth: an alarm queued before an extension, shortening or clearing only
   * reschedules, so it can never destroy a still-live artifact, and an alarm
   * for a repository that is already gone only cancels itself.
   */
  async alarm(): Promise<void> {
    // Test-only: hold the alarm before it reads the row, so a request can
    // arrive after the deadline while the expired row still exists. Unset in
    // production.
    const env = this.env as unknown as Record<string, string | undefined>;
    if (env.TEST_EXPIRATION_ALARM_HOLD_MS) await new Promise(resolve => setTimeout(resolve, Number(env.TEST_EXPIRATION_ALARM_HOLD_MS)));
    this.ensureTable();
    let row = this.ctx.storage.sql
      .exec<{ id: string; expires_at: number | null; expiration_revision: number; projected_revision: number }>(
        `SELECT id, expires_at, expiration_revision, projected_revision FROM _artifact LIMIT 1`,
      ).toArray()[0];
    if (!row) { await this.ctx.storage.deleteAlarm(); return; }
    if (row.projected_revision < row.expiration_revision) {
      await this.project(row.expiration_revision);
      row = this.ctx.storage.sql
        .exec<{ id: string; expires_at: number | null; expiration_revision: number; projected_revision: number }>(
          `SELECT id, expires_at, expiration_revision, projected_revision FROM _artifact LIMIT 1`,
        ).toArray()[0];
      if (!row) { await this.ctx.storage.deleteAlarm(); return; }
    }
    const deadline = row.expires_at != null ? row.expires_at * 1000 : null;
    if (deadline != null && deadline <= Date.now()) {
      // Remove the library row before this object's storage: the call is
      // idempotent, and a failure leaves the alarm retryable rather than the
      // library pointing at an artifact whose repository is gone.
      await this.env.REGISTRY.getByName('registry').remove(row.id);
      await this.destroy();
      return;
    }
    // Nothing is due yet: the deadline lies ahead, or there is none and only a
    // retry it already attempted is still owed.
    await this.scheduleAlarm();
  }
}
