/**
 * Repo: one Durable Object per artifact. Its SQLite holds a whole Fossil
 * repository (go-libfossil's tables, via src/fossil.ts) plus one row of
 * artifact metadata and the hashes of its three link tokens.
 */

import { DurableObject } from 'cloudflare:workers';
import { run, type FossilReply, type FossilRequest } from './fossil';
import { b64encode, genId, genToken, sha256hex, timingSafeEqual } from './util';
import { WAKE_FANOUT, ticketKind, type WakeKind } from './wake';
import { RESPONDER_STATUS_FILE, applyStatus, resolveChange, statusFrom, type StatusRequest } from './responder-status';
import { GUEST_DISCUSSION, GUEST_TTL, guestAuthor } from './guest';
import { ticketTitle, type ticketChange } from './ticket-body';
import { ticketAuthor } from './ticket-author';
import type { DiscussionContext, DiscussionQuery } from './discussion';
import { htmlSearchDocument, searchChunks, SEARCH_LIMITS, type SearchChunk, type SearchStatus } from './search';
import { externalRef } from './blobs';
import { SearchSource } from './search-source';
import { b64decode } from './util';

/** Resolved by the Worker from independent session/guest credentials, never request JSON. */
export interface DiscussionPerson { accountId?: string; accountName?: string; guestHash: string }
interface DiscussionViewer { key: string | null; label: string; verified: boolean; blocked?: boolean }
interface DiscussionThread {
  uuid: string; status: string; changed: string; fields: Record<string, string>; changes: TicketChange[];
  ref?: number; mine?: boolean; unread?: boolean; following?: boolean; context?: DiscussionContext; lastChange?: string;
}
type MessageProof = { artifact: string; ticket: string; principal: string; context: string };
type CorrectionProof = { artifact: string; ticket: string; original: string; text: string };

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
  time?: string;
  comment?: string;
  fields?: Record<string, string>;
  text?: string;
  canEdit?: boolean;
  edited?: boolean;
  history?: { artifact: string; text: string; time?: string }[];
}

/** Each role can do everything the ones before it can. */
export type Role = 'read' | 'comment' | 'write';
const RANK: Record<Role, number> = { read: 0, comment: 1, write: 2 };

// History budgets are checked before WASM expansion. They do not truncate responses:
// traversal continues with a cursor, or a single oversized history fails explicitly.
const DISCUSSION_SCAN_THREADS = 32;
const DISCUSSION_HISTORY_BYTES = 512 * 1024;
const DISCUSSION_HISTORY_EVENTS = 4096;
const DISCUSSION_RESULT_BYTES = 2 * 1024 * 1024;

/** A guest listing cursor: the last row's [createdAt, id]; unreadable values seek from the newest. */
function cursorAt(cursor: string): number {
  try { const v = JSON.parse(cursor) as [number, string]; return Number.isSafeInteger(v[0]) ? v[0] : 0; } catch { return 0; }
}
function cursorId(cursor: string): string {
  try { const v = JSON.parse(cursor) as [number, string]; return typeof v[1] === 'string' ? v[1] : ''; } catch { return ''; }
}

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

/** A guest's private profile on one artifact; never part of the Fossil repository. */
export interface GuestRow {
  id: string;
  name: string;
  email: string;
  blocked: boolean;
  claimedAccountId: string | null;
  permission: Role | null;
  createdAt: number;
}

/** What a guest may read of its own profile: no hash, and a claim is only a request. */
export interface GuestProfile {
  id: string;
  name: string;
  email: string;
  claimedAccountId?: string;
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
  private contentQueue: Promise<void> = Promise.resolve();

  private async contentChange<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.contentQueue;
    let release!: () => void;
    this.contentQueue = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try { return await action(); } finally { release(); }
  }

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
    if (!artifactCols.includes('search_revision')) sql.exec(`ALTER TABLE _artifact ADD COLUMN search_revision INTEGER NOT NULL DEFAULT 0`);
    if (!artifactCols.includes('search_pending')) sql.exec(`ALTER TABLE _artifact ADD COLUMN search_pending INTEGER NOT NULL DEFAULT 0`);
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
    await this.indexSearch();
    return reply;
  }

  async indexSearch(): Promise<boolean> {
    return this.contentChange(async () => {
      this.ensureTable();
      this.ctx.storage.sql.exec('UPDATE _artifact SET search_revision=1,search_pending=1 WHERE search_revision=0');
      return this.projectSearchIndex();
    });
  }

  private async beginSearch(): Promise<boolean> {
    this.ensureTable();
    const m = this.meta();
    if (!m) return false;
    this.ctx.storage.sql.exec('UPDATE _artifact SET search_revision=search_revision+1,search_pending=1');
    await this.scheduleAlarm();
    const row = this.ctx.storage.sql.exec<{ search_revision:number }>('SELECT search_revision FROM _artifact LIMIT 1').toArray()[0];
    if (!row) return false;
    // Invalidate before the content write. If the inventory is unavailable the
    // write has not happened, so a retry cannot duplicate a successful commit.
    await this.env.REGISTRY.getByName('registry').searchPending(m.id,row.search_revision);
    return !!this.meta();
  }

  private async projectSearchIndex(): Promise<boolean> {
    this.ensureTable();
    const m = this.meta();
    const version = this.ctx.storage.sql.exec<{ search_revision:number }>('SELECT search_revision FROM _artifact LIMIT 1').toArray()[0]?.search_revision;
    if (!m || version === undefined) return false;
    try {
      await this.scheduleAlarm();
      await this.env.REGISTRY.getByName('registry').searchPending(m.id,version);
      const tip = run<{ tip: string }>(this.ctx.storage,{ op:'tip' }).result?.tip;
      if (!tip) throw new Error('Current check-in is unavailable');
      // filename/mlink are Fossil's crosslinked inventory. Looking at historical
      // candidates avoids guessing a full tree from mlink (which records changes,
      // not every file). raw(at) verifies each candidate against the current tree.
      // A historical oversize or too many candidates conservatively means partial.
      const paths = this.ctx.storage.sql.exec<{ path:string; bytes:number | null }>(`SELECT f.name AS path,max(b.size) AS bytes FROM filename f LEFT JOIN mlink m ON m.fnid=f.fnid LEFT JOIN blob b ON b.rid=m.fid
        WHERE lower(f.name) LIKE '%.html' OR lower(f.name) LIKE '%.htm' GROUP BY f.name
        ORDER BY (lower(f.name)='index.html') DESC,f.name LIMIT ?`,SEARCH_LIMITS.files + 1).toArray();
      const chunks: SearchChunk[] = [];
      const source = new SearchSource(this.ctx.storage);
      let partial = paths.length > SEARCH_LIMITS.files, bytes = 0, textBytes = 0, htmlFiles = 0;
      for (const file of paths.slice(0, SEARCH_LIMITS.files)) {
        if (file.bytes === null || file.bytes < 0 || file.bytes > SEARCH_LIMITS.fileBytes) { partial = true; continue; }
        const raw = await source.read<{ data:string }>({ op:'raw',path:file.path,at:tip });
        if (!raw.ok || !raw.result) { partial = true; continue; }
        htmlFiles++;
        let data = b64decode(raw.result.data);
        const pointer = externalRef(data);
        if (pointer) {
          if (pointer.kind !== 'blob' || pointer.size > SEARCH_LIMITS.fileBytes || bytes + pointer.size > SEARCH_LIMITS.totalBytes) { partial = true; continue; }
          const allowed = await this.env.REGISTRY.getByName('registry').allowedBlobs(m.id,[`artifact:${m.id}`],[pointer.sha256]);
          if (!allowed.includes(pointer.sha256)) { partial = true; continue; }
          const object = await this.env.BLOBS.get(`b/${pointer.sha256}`);
          if (!object || object.size !== pointer.size) { partial = true; continue; }
          data = new Uint8Array(await object.arrayBuffer());
          const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',data)), b => b.toString(16).padStart(2,'0')).join('');
          if (digest !== pointer.sha256) { partial = true; continue; }
        }
        bytes += data.byteLength;
        if (bytes > SEARCH_LIMITS.totalBytes || textBytes >= SEARCH_LIMITS.text) { partial = true; break; }
        const extracted = await htmlSearchDocument(new TextDecoder('utf-8',{ fatal:true,ignoreBOM:false }).decode(data));
        const text = extracted.text;
        if (extracted.partial || textBytes + text.length > SEARCH_LIMITS.text) partial = true;
        const kept = text.slice(0,SEARCH_LIMITS.text - textBytes);
        textBytes += kept.length;
        chunks.push(...searchChunks(file.path,kept));
      }
      const status: SearchStatus = partial ? 'partial' : htmlFiles && chunks.length ? 'complete' : 'unsupported';
      this.ensureTable();
      if (!this.meta() || this.ctx.storage.sql.exec<{ search_revision:number }>('SELECT search_revision FROM _artifact LIMIT 1').toArray()[0]?.search_revision !== version) return false;
      await this.env.REGISTRY.getByName('registry').projectSearch({ id:m.id,version,status,chunks });
      this.ctx.storage.sql.exec('UPDATE _artifact SET search_pending=0 WHERE search_revision=?',version);
      await this.scheduleAlarm();
      return true;
    } catch {
      try { await this.env.REGISTRY.getByName('registry').projectSearch({ id:m.id,version,status:'error',chunks:[] }); } catch { /* Durable pending revision retries through the alarm. */ }
      try { await this.scheduleAlarm(); } catch { /* The previously armed alarm still owns the durable job. */ }
      return false;
    }
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
    if (request.op === 'ticketAdd' || request.op === 'ticketSet') {
      this.provenanceTable();
      return run<{ artifact: string }>(this.ctx.storage, request, undefined, result => {
        if (result?.artifact) this.markChange(result.artifact, 'edit');
      });
    }
    if (request.op === 'commit') return this.contentChange(async () => {
      if (!await this.beginSearch()) return { error:'not found',code:'not_found' };
      const reply = run<unknown>(this.ctx.storage,request);
      await this.projectSearchIndex();
      return reply;
    });
    const reply = run<unknown>(this.ctx.storage, request);
    if (reply.ok && request.op === 'ticketChanges') this.decorateChanges(reply.result as TicketChange[]);
    if (reply.ok && request.op === 'ticketThreads') {
      const result = reply.result as { tickets: { fields?: Record<string, string>; changes: TicketChange[] }[] };
      for (const ticket of result.tickets) {
        this.stripAuthority(ticket.fields);
        this.decorateChanges(ticket.changes);
      }
    }
    return reply;
  }

  /** Authority is private server state, never a field supplied by a Fossil client. */
  private provenanceTable(): void {
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS _ticket_provenance (
      artifact TEXT PRIMARY KEY, authority TEXT NOT NULL, guest TEXT NOT NULL DEFAULT '')`);
  }

  private markChange(artifact: string, authority: 'edit' | 'view', guest = ''): void {
    this.ctx.storage.sql.exec('INSERT OR IGNORE INTO _ticket_provenance (artifact, authority, guest) VALUES (?, ?, ?)', artifact, authority, guest);
  }

  private stripAuthority(fields?: Record<string, string>): void {
    if (!fields) return;
    delete fields.authority;
    delete fields.intent;
    delete fields.guest;
  }

  private decorateChanges(changes: TicketChange[]): void {
    this.provenanceTable();
    for (const change of changes) {
      this.stripAuthority(change.fields);
      const proof = this.ctx.storage.sql.exec<{ authority: string; guest: string }>(
        'SELECT authority, guest FROM _ticket_provenance WHERE artifact = ?', change.artifact,
      ).toArray()[0];
      if (!proof || (proof.authority !== 'edit' && proof.authority !== 'view')) continue;
      change.fields ??= {};
      change.fields.authority = proof.authority;
      change.fields.intent = 'comment';
      if (proof.authority === 'view' && proof.guest) change.fields.guest = proof.guest;
    }
  }

  /**
   * Fossil's sync protocol; the repository's own logins decide access. When
   * the request stored artifacts (a push), the result also lists the ticket
   * changes among them, so the Worker can wake for each.
   */
  async sync(body: Uint8Array, cookie: string): Promise<FossilReply<{ data: string; tickets?: PushedTicket[] }>> {
    this.ensureTable();
    if (!this.meta()) return { error: 'not found', code: 'not_found' };
    return this.contentChange(async () => {
      const meta = this.meta();
      if (!meta) return {error:'not found',code:'not_found'};
      const before = this.lastArrived();
      let version: number | null = null;
      const r = run<{data:string}>(this.ctx.storage,{op:'sync',cookie},body,() => {
        if (this.lastArrived() === before) return;
        // The successful content write and its index outbox share run's one
        // rollback boundary. Authentication failures and no-ops enqueue nothing.
        this.ctx.storage.sql.exec('UPDATE _artifact SET search_revision=search_revision+1,search_pending=1');
        version = this.ctx.storage.sql.exec<{search_revision:number}>('SELECT search_revision FROM _artifact LIMIT 1').toArray()[0]!.search_revision;
      });
      // Capture arrivals before any projection await; only these wake the Worker.
      const result = r.ok && r.result && before && version !== null
        ? {...r,result:{...r.result,tickets:this.ticketsSince(before)}} : r;
      const defer = (this.env as unknown as Record<string,string | undefined>).TEST_NATIVE_SEARCH_FAULT === 'defer-projection-and-fail-alarm-once';
      try {
        let failAlarm = false;
        if (version !== null && defer && !await this.ctx.storage.get<boolean>('native-search-alarm-fault-used')) {
          await this.ctx.storage.put('native-search-alarm-fault-used',true); failAlarm = true;
        }
        this.ensureTable();
        // Repair an earlier scheduling failure even on a later no-op, without
        // changing its revision or reading source content. A transient failure
        // gets one immediate retry; the durable outbox also survives restart.
        if (version !== null || this.searchPending()) for (let attempt=0;attempt<2;attempt++) {
          try {
            if (failAlarm) { failAlarm = false; throw new Error('injected native alarm scheduling failure'); }
            await this.scheduleAlarm(); break;
          } catch { /* The next attempt/access or owner backfill can repair scheduling. */ }
        }
      } catch { /* A successful native write must not become an index retry request. */ }
      if (version !== null) {
        try { await this.env.REGISTRY.getByName('registry').searchPending(meta.id,version); } catch { /* The durable outbox retries notification. */ }
        if (!defer) try { await this.projectSearchIndex(); } catch { /* Preserve the successful protocol reply and its pending outbox. */ }
      }
      return result;
    });
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

  // ─── Personal discussion state ────────────────────────────────────────────

  private discussionTables(): void {
    this.provenanceTable();
    const sql = this.ctx.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS _discussion_ref (ref INTEGER PRIMARY KEY AUTOINCREMENT, ticket TEXT NOT NULL UNIQUE)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS _discussion_message (artifact TEXT PRIMARY KEY, ticket TEXT NOT NULL, principal TEXT NOT NULL, context TEXT NOT NULL DEFAULT '')`);
    sql.exec(`CREATE TABLE IF NOT EXISTS _discussion_correction (artifact TEXT PRIMARY KEY, ticket TEXT NOT NULL, original TEXT NOT NULL, text TEXT NOT NULL)`);
    sql.exec('CREATE INDEX IF NOT EXISTS _discussion_message_ticket ON _discussion_message(ticket)');
    sql.exec('CREATE INDEX IF NOT EXISTS _discussion_correction_ticket ON _discussion_correction(ticket)');
    sql.exec(`CREATE TABLE IF NOT EXISTS _discussion_view (principal TEXT NOT NULL, ticket TEXT NOT NULL, read_through TEXT NOT NULL DEFAULT '', following INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (principal, ticket))`);
  }

  private discussionViewer(person: DiscussionPerson): DiscussionViewer {
    const guest = person.guestHash ? this.guestRow('token_hash = ?', person.guestHash) : null;
    // A different display identity does not clear this browser's existing moderation block.
    if (person.accountId) return { key: `account:${person.accountId}`, label: person.accountName || 'Account', verified: true, blocked: guest?.blocked ?? false };
    return guest ? { key: `guest:${guest.id}`, label: guest.name, verified: false, blocked: guest.blocked }
      : { key: null, label: 'Guest', verified: false };
  }

  private threadRef(ticket: string): number {
    const known = this.ctx.storage.sql.exec<{ ref: number }>('SELECT ref FROM _discussion_ref WHERE ticket = ?', ticket).toArray()[0];
    if (known) return known.ref;
    // INSERT OR IGNORE would consume AUTOINCREMENT numbers even on a conflict.
    return this.ctx.storage.sql.exec<{ ref: number }>('INSERT INTO _discussion_ref (ticket) VALUES (?) RETURNING ref', ticket).toArray()[0]!.ref;
  }

  private messageText(change: TicketChange): string { return change.fields?.comment ?? change.comment ?? ''; }

  /** Stored blob.size is the expanded artifact size, so this check happens before WASM expands history. */
  private discussionCost(ticket: string): { bytes: number; count: number } {
    return this.ctx.storage.sql.exec<{ bytes: number; count: number }>(`SELECT COALESCE(SUM(MAX(b.size, 0)), 0) AS bytes, COUNT(*) AS count FROM tagxref x JOIN tag t ON t.tagid = x.tagid JOIN blob b ON b.rid = x.rid WHERE t.tagname = ?`, `tkt-${ticket}`).toArray()[0]!;
  }

  private discussionSizeError(ticket: string, resumeCursor: string | null = null): FossilReply<never> {
    return {
      error: 'This discussion exceeds the safe size for one complete history response. No messages were omitted or changed.',
      code: 'discussion_too_large', ticketUuid: ticket, ref: this.threadRef(ticket), resumeCursor,
    };
  }

  private discussionChanges(ticket: string, cost = this.discussionCost(ticket)): FossilReply<TicketChange[]> {
    if (cost.bytes > DISCUSSION_HISTORY_BYTES || cost.count > DISCUSSION_HISTORY_EVENTS) return this.discussionSizeError(ticket);
    return run<TicketChange[]>(this.ctx.storage, { op: 'ticketChanges', ticketUuid: ticket });
  }

  /** Full metadata is the inherited TicketList cost; histories are bounded sequential scans, never one all-history WASM value. */
  async discussionThreads(caller: Caller, person: DiscussionPerson, query: DiscussionQuery): Promise<FossilReply<unknown>> {
    if (!(await this.role(caller)) || !this.meta()) return { error: 'not found', code: 'not_found' };
    this.discussionTables();
    const viewer = this.discussionViewer(person);
    const r = run<DiscussionThread[]>(this.ctx.storage, { op: 'ticketList' });
    if (!r.ok || !r.result) return r;
    // Backfill imported/legacy tickets by immutable UUID, not activity or display order.
    this.ctx.storage.transactionSync(() => {
      for (const t of [...r.result!].sort((a, b) => a.uuid.localeCompare(b.uuid))) t.ref = this.threadRef(t.uuid);
    });
    // Exact lookup selects the one artifact-local ticket BEFORE scan chunking; it never searches only the first cohort.
    const tickets = (query.thread ? r.result.filter(t => t.uuid === query.thread) : r.result)
      .sort((a, b) => query.sort === 'reference' ? a.ref! - b.ref! : b.changed.localeCompare(a.changed) || a.uuid.localeCompare(b.uuid));
    if (query.thread && !tickets.length) return { error: 'not found', code: 'not_found' };
    const signature = JSON.stringify([query.limit, query.q, query.filter, query.sort, viewer.key]);
    let index = 0;
    if (query.cursor) {
      let cursor: unknown;
      try { cursor = JSON.parse(query.cursor); } catch { return { error: 'Invalid cursor', code: 'bad_request' }; }
      if (!Array.isArray(cursor) || cursor.length !== 3 || cursor[0] !== 1 || cursor[1] !== signature || typeof cursor[2] !== 'string') return { error: 'Invalid cursor', code: 'bad_request' };
      index = tickets.findIndex(t => t.uuid === cursor[2]);
      if (index < 0) return { error: 'Invalid cursor', code: 'bad_request' };
      index++;
    }
    const page: DiscussionThread[] = [];
    let scanned = 0, expandedBytes = 0, resultBytes = 0;
    while (index < tickets.length && scanned < DISCUSSION_SCAN_THREADS && page.length < query.limit) {
      const ticket = tickets[index]!;
      const open = !ticket.status || ticket.status === 'Open';
      if ((query.filter === 'open' && !open) || (query.filter === 'resolved' && open)) {
        scanned++;
        index++;
        continue;
      }
      if (query.filter === 'following' && (!viewer.key || !this.ctx.storage.sql.exec('SELECT 1 FROM _discussion_view WHERE principal = ? AND ticket = ? AND following = 1', viewer.key, ticket.uuid).toArray().length)) {
        scanned++;
        index++;
        continue;
      }
      const cost = this.discussionCost(ticket.uuid);
      if (cost.bytes > DISCUSSION_HISTORY_BYTES || cost.count > DISCUSSION_HISTORY_EVENTS) {
        if (page.length) break; // Preserve the normal cohort and stop BEFORE this candidate.
        return this.discussionSizeError(ticket.uuid, query.thread ? null : JSON.stringify([1, signature, ticket.uuid]));
      }
      // Stop before consuming this candidate. The cursor names the LAST scanned candidate, even with no matches.
      if (expandedBytes + cost.bytes > DISCUSSION_HISTORY_BYTES) break;
      const changes = this.discussionChanges(ticket.uuid, cost);
      if (!changes.ok || !changes.result) return changes;
      const raw = changes.result;
      expandedBytes += cost.bytes;
      const messages = this.ctx.storage.sql.exec<MessageProof>('SELECT artifact, ticket, principal, context FROM _discussion_message WHERE ticket = ?', ticket.uuid).toArray();
      const owners = new Map(messages.map(m => [m.artifact, m]));
      const corrections = this.ctx.storage.sql.exec<CorrectionProof>('SELECT artifact, ticket, original, text FROM _discussion_correction WHERE ticket = ?', ticket.uuid).toArray();
      const linked = new Map(corrections.map(c => [c.artifact, c]));
      const states = viewer.key ? this.ctx.storage.sql.exec<{ ticket: string; read_through: string; following: number }>('SELECT ticket, read_through, following FROM _discussion_view WHERE principal = ? AND ticket = ?', viewer.key, ticket.uuid).toArray() : [];
      const views = new Map(states.map(s => [s.ticket, s]));
      this.stripAuthority(ticket.fields);
      this.decorateChanges(raw);
      ticket.ref = this.threadRef(ticket.uuid);
      ticket.mine = !!viewer.key && raw.some(c => owners.get(c.artifact)?.ticket === ticket.uuid && owners.get(c.artifact)?.principal === viewer.key);
      ticket.lastChange = raw.at(-1)?.artifact;
      ticket.following = !!views.get(ticket.uuid)?.following;
      ticket.unread = !!viewer.key && !!ticket.lastChange && views.get(ticket.uuid)?.read_through !== ticket.lastChange;
      const correctionHistory = new Map<string, { artifact: string; text: string; time?: string }[]>();
      for (const event of raw) {
        const correction = linked.get(event.artifact);
        if (correction?.ticket !== ticket.uuid || owners.get(correction.original)?.ticket !== ticket.uuid) continue;
        const history = correctionHistory.get(correction.original) ?? [];
        history.push({ artifact: event.artifact, text: correction.text, time: event.time });
        correctionHistory.set(correction.original, history);
      }
      ticket.changes = raw.filter(c => linked.get(c.artifact)?.ticket !== ticket.uuid);
      for (const change of ticket.changes) {
        const proof = owners.get(change.artifact);
        const trusted = proof?.ticket === ticket.uuid;
        const original = this.messageText(change);
        const history = [{ artifact: change.artifact, text: original, time: change.time }, ...(trusted ? correctionHistory.get(change.artifact) ?? [] : [])];
        change.text = history.at(-1)!.text;
        change.edited = history.length > 1;
        change.history = history;
        change.canEdit = !!trusted && !!viewer.key && !viewer.blocked && proof!.principal === viewer.key && !!original.trim();
        // Existing clients also see corrected canonical text, without losing the original history.
        if (change.fields?.comment !== undefined) change.fields.comment = change.text;
        else change.comment = change.text;
        if (trusted && proof!.context) {
          try { ticket.context = JSON.parse(proof!.context) as DiscussionContext; } catch { /* old malformed private metadata has no display context */ }
        }
      }
      const opening = ticket.changes[0];
      if (opening?.fields?.comment !== undefined) {
        ticket.fields.comment = opening.text ?? '';
        ticket.fields.title = ticketTitle(opening.text ?? '');
      }
      const filterMatches = !((query.filter === 'open' && !open) || (query.filter === 'resolved' && open) || (query.filter === 'mine' && !ticket.mine) || (query.filter === 'unread' && !ticket.unread) || (query.filter === 'following' && !ticket.following));
      const searchMatches = !query.q || [ticket.fields.title ?? '', ticket.context?.label ?? '', ticket.context?.quote ?? '', ...ticket.changes.map(c => c.text ?? '')].join('\n').toLocaleLowerCase().includes(query.q.toLocaleLowerCase());
      if (filterMatches && searchMatches) {
        const bytes = new TextEncoder().encode(JSON.stringify(ticket)).byteLength;
        if (bytes > DISCUSSION_RESULT_BYTES) {
          if (page.length) break;
          return this.discussionSizeError(ticket.uuid, query.thread ? null : JSON.stringify([1, signature, ticket.uuid]));
        }
        if (resultBytes + bytes > DISCUSSION_RESULT_BYTES) break;
        page.push(ticket);
        resultBytes += bytes;
      } else {
        // The metadata array outlives this iteration: do not accidentally retain nonmatching histories on it.
        ticket.changes = [];
      }
      scanned++;
      index++;
    }
    const truncated = index < tickets.length;
    const { blocked: _blocked, ...publicViewer } = viewer;
    return { ok: true, result: { tickets: page, limit: query.limit, truncated, nextCursor: truncated ? JSON.stringify([1, signature, tickets[index - 1]!.uuid]) : null, viewer: publicViewer } };
  }

  /** The role is unchanged by identity selection; identity proves ownership, not capability. */
  async discussionPost(caller: Caller, person: DiscussionPerson, req: NonNullable<ReturnType<typeof ticketChange>>, fallbackAuthor: string, expectedIdentity?: string): Promise<FossilReply<{ ticketUuid: string; artifact: string; discussion: boolean; author: string }>> {
    const role = await this.role(caller);
    if (!role || !this.meta()) return { error: 'not found', code: 'not_found' };
    this.discussionTables();
    const viewer = this.discussionViewer(person);
    if (expectedIdentity !== undefined && expectedIdentity !== viewer.key) return { error: 'Comment identity changed. Refresh before trying again.', code: 'identity_changed' };
    if (viewer.blocked) return { error: 'this guest is blocked from discussing this artifact', code: 'forbidden' };
    const discussion = role === 'read';
    if (discussion && !viewer.key) return { error: 'identify before posting: set your name with PUT …/guest', code: 'forbidden' };
    if (discussion && (req.asResponder || (req.ticketUuid && req.fields.status))) return { error: 'guest discussion cannot change a thread\'s status', code: 'forbidden' };
    const user = req.asResponder ? fallbackAuthor : viewer.key ? (viewer.verified ? ticketAuthor({ kind: 'account', name: viewer.label }) : guestAuthor(viewer.label)) : fallbackAuthor;
    if (req.ticketUuid) {
      const known = this.discussionChanges(req.ticketUuid);
      if (!known.ok) return { ...known, result: undefined };
    }
    const fields = { ...req.fields, ...(discussion ? { severity: GUEST_DISCUSSION } : {}) };
    const result = run<{ ticketUuid?: string; artifact: string }>(this.ctx.storage, { op: req.ticketUuid ? 'ticketSet' : 'ticketAdd', ticketUuid: req.ticketUuid, fields, user, comment: req.comment }, undefined, result => {
      if (!result?.artifact) return;
      const ticket = req.ticketUuid || result.ticketUuid!;
      this.markChange(result.artifact, discussion ? 'view' : 'edit', !viewer.verified ? viewer.key?.slice(6) : '');
      this.threadRef(ticket);
      if (viewer.key) {
        this.ctx.storage.sql.exec('INSERT INTO _discussion_message (artifact, ticket, principal, context) VALUES (?, ?, ?, ?)', result.artifact, ticket, viewer.key, req.context ? JSON.stringify(req.context) : '');
        this.ctx.storage.sql.exec(`INSERT INTO _discussion_view (principal, ticket, read_through) VALUES (?, ?, ?) ON CONFLICT(principal, ticket) DO UPDATE SET read_through = excluded.read_through`, viewer.key, ticket, result.artifact);
      } else if (req.context) {
        this.ctx.storage.sql.exec('INSERT INTO _discussion_message (artifact, ticket, principal, context) VALUES (?, ?, ?, ?)', result.artifact, ticket, '', JSON.stringify(req.context));
      }
    });
    return result.ok && result.result ? { ok: true, result: { ticketUuid: req.ticketUuid || result.result.ticketUuid!, artifact: result.result.artifact, discussion, author: user } } : { error: result.error, code: result.code };
  }

  /** Read/follow preferences are private, require a real principal, and never write Fossil. */
  async discussionView(caller: Caller, person: DiscussionPerson, ticket: string, input: { readThrough?: string; following?: boolean }, expectedIdentity?: string): Promise<FossilReply<unknown>> {
    if (!(await this.role(caller)) || !this.meta()) return { error: 'not found', code: 'not_found' };
    this.discussionTables();
    const viewer = this.discussionViewer(person);
    if (expectedIdentity !== undefined && expectedIdentity !== viewer.key) return { error: 'Comment identity changed. Refresh before trying again.', code: 'identity_changed' };
    if (!viewer.key || viewer.blocked) return { error: 'Identify before saving discussion preferences', code: 'forbidden' };
    const changes = this.discussionChanges(ticket);
    if (!changes.ok) return changes;
    if (!changes.result?.length) return { error: 'not found', code: 'not_found' };
    const state = this.ctx.storage.sql.exec<{ read_through: string; following: number }>('SELECT read_through, following FROM _discussion_view WHERE principal = ? AND ticket = ?', viewer.key, ticket).toArray()[0];
    let readThrough = state?.read_through ?? '';
    const requested = input.readThrough ?? (input.following === undefined ? changes.result.at(-1)!.artifact : undefined);
    if (requested) {
      const index = changes.result.findIndex(c => c.artifact === requested);
      if (index < 0) return { error: 'not found', code: 'not_found' };
      // Delayed responses/opening an older message must never move a marker backwards.
      const previous = changes.result.findIndex(c => c.artifact === readThrough);
      if (index >= previous) readThrough = requested;
    }
    const following = input.following ?? !!state?.following;
    this.ctx.storage.sql.exec(`INSERT INTO _discussion_view (principal, ticket, read_through, following) VALUES (?, ?, ?, ?) ON CONFLICT(principal, ticket) DO UPDATE SET read_through = excluded.read_through, following = excluded.following`, viewer.key, ticket, readThrough, following ? 1 : 0);
    return { ok: true, result: { ticketUuid: ticket, following, unread: readThrough !== changes.result.at(-1)!.artifact } };
  }

  /** Append a text-only correction, with its trusted original linkage committed atomically. */
  async correctDiscussion(caller: Caller, person: DiscussionPerson, ticket: string, original: string, text: string, expectedIdentity?: string): Promise<FossilReply<{ ticketUuid: string; artifact: string; correctionOf: string; discussion: boolean; author: string }>> {
    if (!(await this.role(caller)) || !this.meta()) return { error: 'not found', code: 'not_found' };
    this.discussionTables();
    const viewer = this.discussionViewer(person);
    if (expectedIdentity !== undefined && expectedIdentity !== viewer.key) return { error: 'Comment identity changed. Refresh before trying again.', code: 'identity_changed' };
    const denied = { error: 'not found', code: 'not_found' };
    if (!viewer.key || viewer.blocked) return denied;
    // Both bindings are private server proofs. Imported fields and shared capability possession prove nothing.
    const proof = this.ctx.storage.sql.exec<{ principal: string; ticket: string; authority: string }>(`SELECT m.principal, m.ticket, p.authority FROM _discussion_message m JOIN _ticket_provenance p ON p.artifact = m.artifact WHERE m.artifact = ?`, original).toArray()[0];
    if (!proof || proof.principal !== viewer.key || proof.ticket !== ticket || (proof.authority !== 'view' && proof.authority !== 'edit')) return denied;
    const known = this.discussionChanges(ticket);
    if (!known.ok) return { ...known, result: undefined };
    const source = known.result?.find(c => c.artifact === original);
    if (!known.ok || !source || !this.messageText(source).trim()) return denied;
    if (!text.trim() || text.length > 8000 || /\0/.test(text)) return { error: 'Invalid correction text', code: 'bad_request' };
    const discussion = proof.authority === 'view';
    const fields = discussion ? { severity: GUEST_DISCUSSION } : {};
    // Keep the original author and authority even if the owner's current artifact role changed.
    const r = run<{ artifact: string }>(this.ctx.storage, { op: 'ticketSet', ticketUuid: ticket, fields, user: source.user, comment: text }, undefined, result => {
      if (!result?.artifact) return;
      this.markChange(result.artifact, proof.authority as 'view' | 'edit', !viewer.verified ? viewer.key!.slice(6) : '');
      this.ctx.storage.sql.exec('INSERT INTO _discussion_correction (artifact, ticket, original, text) VALUES (?, ?, ?, ?)', result.artifact, ticket, original, text);
      this.ctx.storage.sql.exec(`INSERT INTO _discussion_view (principal, ticket, read_through) VALUES (?, ?, ?) ON CONFLICT(principal, ticket) DO UPDATE SET read_through = excluded.read_through`, viewer.key!, ticket, result.artifact);
    });
    return r.ok && r.result ? { ok: true, result: { ticketUuid: ticket, artifact: r.result.artifact, correctionOf: original, discussion, author: source.user } } : { error: r.error, code: r.code };
  }

  // ─── Guests ────────────────────────────────────────────────────────────────
  //
  // A guest identity belongs to one artifact's repository object and lives
  // beside the Fossil tables, never in them: no clone, ticket field, timeline
  // entry or wake carries its email or token. Every method here runs inside
  // the object, so the role check and the write it authorizes cannot be
  // separated by another request.

  private guestTable(): void {
    this.ensureTable();
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS _guest (
      id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, name TEXT NOT NULL, email TEXT NOT NULL DEFAULT '',
      blocked INTEGER NOT NULL DEFAULT 0, claimed_account_id TEXT, permission TEXT, created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)`);
  }

  private guestRow(where: string, arg: string): GuestRow | null {
    this.guestTable();
    const r = this.ctx.storage.sql.exec<{
      id: string; name: string; email: string; blocked: number; claimed_account_id: string | null;
      permission: string | null; created_at: number;
    }>(`SELECT id, name, email, blocked, claimed_account_id, permission, created_at FROM _guest WHERE ${where} AND expires_at > ?`, arg, Math.floor(Date.now() / 1000)).toArray()[0];
    return r ? {
      id: r.id, name: r.name, email: r.email, blocked: !!r.blocked, claimedAccountId: r.claimed_account_id,
      permission: r.permission === 'read' || r.permission === 'write' ? r.permission : null, createdAt: r.created_at,
    } : null;
  }

  /** The guest the cookie token names on this artifact, or null (an unknown, expired or spoofed token). */
  async guestByToken(hash: string): Promise<GuestRow | null> {
    return hash ? this.guestRow('token_hash = ?', hash) : null;
  }

  async guest(id: string): Promise<GuestRow | null> {
    return this.guestRow('id = ?', id);
  }

  /**
   * The profile `hash` names, or a new identity when there is none. `create`
   * reports whether the caller must be given its cookie. Expired rows are
   * cleared first, so an expired token can never revive.
   */
  async guestIdentify(hash: string, name: string, email: string): Promise<{ guest: GuestRow; create: boolean }> {
    this.guestTable();
    const now = Math.floor(Date.now() / 1000);
    this.ctx.storage.sql.exec('DELETE FROM _guest WHERE expires_at <= ?', now);
    const found = hash ? this.guestRow('token_hash = ?', hash) : null;
    if (found) {
      this.ctx.storage.sql.exec('UPDATE _guest SET name = ?, email = ?, updated_at = ? WHERE id = ?', name, email, now, found.id);
      return { guest: { ...found, name, email }, create: false };
    }
    const id = genId();
    this.ctx.storage.sql.exec('INSERT INTO _guest (id, token_hash, name, email, created_at, updated_at, expires_at) VALUES (?,?,?,?,?,?,?)',
      id, hash, name, email, now, now, now + GUEST_TTL);
    return { guest: { id, name, email, blocked: false, claimedAccountId: null, permission: null, createdAt: now }, create: true };
  }

  /**
   * Link a guest to a verified account. Only an existing, unexpired guest the
   * cookie names, actively unblocked, is linked; the email is never a match.
   */
  async guestClaim(hash: string, accountId: string): Promise<'ok' | 'missing' | 'blocked' | 'conflict'> {
    // No await between reading the claim and writing it: competing accounts
    // cannot both observe an unclaimed profile and overwrite one another.
    const guest = hash ? this.guestRow('token_hash = ?', hash) : null;
    if (!guest) return 'missing';
    if (guest.blocked) return 'blocked';
    if (guest.claimedAccountId && guest.claimedAccountId !== accountId) return 'conflict';
    this.ctx.storage.sql.exec('UPDATE _guest SET claimed_account_id = ?, updated_at = ? WHERE id = ?',
      accountId, Math.floor(Date.now() / 1000), guest.id);
    return 'ok';
  }

  /** Block or unblock a guest; the next post it makes is refused or allowed. */
  async guestBlock(id: string, blocked: boolean): Promise<boolean> {
    this.guestTable();
    return this.ctx.storage.sql.exec('UPDATE _guest SET blocked = ?, updated_at = ? WHERE id = ?',
      blocked ? 1 : 0, Math.floor(Date.now() / 1000), id).rowsWritten > 0;
  }

  /** Record the owner's upgrade request on the guest row; the grant itself lives in the Registry. */
  async guestPermission(id: string, permission: Role): Promise<boolean> {
    this.guestTable();
    return this.ctx.storage.sql.exec('UPDATE _guest SET permission = ?, updated_at = ? WHERE id = ?',
      permission, Math.floor(Date.now() / 1000), id).rowsWritten > 0;
  }

  /** A bounded page of guests, newest first; a cursor is the last row's [createdAt, id]. */
  async guests(limit: number, cursor: string): Promise<{ guests: GuestRow[]; nextCursor: string | null }> {
    this.guestTable();
    const rows = this.ctx.storage.sql.exec<{
      id: string; name: string; email: string; blocked: number; claimed_account_id: string | null;
      permission: string | null; created_at: number;
    }>(`SELECT id, name, email, blocked, claimed_account_id, permission, created_at FROM _guest
      WHERE expires_at > ? AND (? = '' OR created_at < ? OR (created_at = ? AND id < ?))
      ORDER BY created_at DESC, id DESC LIMIT ?`,
    Math.floor(Date.now() / 1000), cursor, cursorAt(cursor), cursorAt(cursor), cursorId(cursor), limit + 1).toArray();
    const page = rows.slice(0, limit), last = page.at(-1);
    return {
      guests: page.map(r => ({
        id: r.id, name: r.name, email: r.email, blocked: !!r.blocked, claimedAccountId: r.claimed_account_id,
        permission: r.permission === 'read' || r.permission === 'write' ? r.permission : null, createdAt: r.created_at,
      })),
      nextCursor: rows.length > limit && last ? JSON.stringify([last.created_at, last.id]) : null,
    };
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

  private searchPending(): boolean {
    return !!this.ctx.storage.sql.exec<{ search_pending:number }>('SELECT search_pending FROM _artifact LIMIT 1').toArray()[0]?.search_pending;
  }

  /** Arm the one alarm at the earliest of the deadline and any retry it owes. */
  private async scheduleAlarm(): Promise<void> {
    this.ensureTable();
    const row = this.ctx.storage.sql
      .exec<{ expires_at: number | null }>(`SELECT expires_at FROM _artifact LIMIT 1`).toArray()[0];
    if (!row) { await this.ctx.storage.deleteAlarm(); return; }
    const times: number[] = [];
    if (row.expires_at != null) times.push(row.expires_at * 1000);
    if (this.pending() || this.searchPending()) times.push(Date.now() + this.retryMs());
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
      .exec<{ id: string; title: string; expires_at: number | null; expiration_revision: number; projected_revision: number }>(
        `SELECT id, title, expires_at, expiration_revision, projected_revision FROM _artifact LIMIT 1`,
      ).toArray()[0];
    if (!row) { await this.ctx.storage.deleteAlarm(); return; }
    if (row.projected_revision < row.expiration_revision) {
      await this.project(row.expiration_revision);
      row = this.ctx.storage.sql
        .exec<{ id: string; title: string; expires_at: number | null; expiration_revision: number; projected_revision: number }>(
          `SELECT id, title, expires_at, expiration_revision, projected_revision FROM _artifact LIMIT 1`,
        ).toArray()[0];
      if (!row) { await this.ctx.storage.deleteAlarm(); return; }
    }
    const deadline = row.expires_at != null ? row.expires_at * 1000 : null;
    if (deadline != null && deadline <= Date.now()) {
      // Remove the library row before this object's storage: the call is
      // idempotent, and a failure leaves the alarm retryable rather than the
      // library pointing at an artifact whose repository is gone. The removal
      // records the expiry itself, in the same transaction and only while the
      // row is still there, so a retried alarm adds no second event.
      await this.env.REGISTRY.getByName('registry').remove(row.id, { reason: 'expired', expiresAt: row.expires_at, title: row.title });
      await this.destroy();
      return;
    }
    if (this.searchPending()) await this.contentChange(() => this.projectSearchIndex());
    // Expiration and content projection share this object's one alarm.
    await this.scheduleAlarm();
  }
}
