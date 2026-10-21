/**
 * Repo: one Durable Object per artifact. Its SQLite holds a whole Fossil
 * repository (go-libfossil's tables, via src/fossil.ts) plus one row of
 * artifact metadata and the hashes of its two link tokens.
 */

import { DurableObject } from 'cloudflare:workers';
import { run, type FossilReply, type FossilRequest } from './fossil';
import { sha256hex, timingSafeEqual } from './util';

export type Role = 'read' | 'write';

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
  tip: 'read', info: 'read', bundle: 'read', raw: 'read', uvGet: 'read', uvList: 'read',
  commit: 'write', uvSet: 'write',
};

export class Repo extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Fossil runs with foreign keys off. The pragma lasts for the connection
    // but is ignored inside a transaction, and every write in a call opens
    // one, so set it here before anything else runs.
    ctx.storage.sql.exec('PRAGMA foreign_keys = OFF');
  }

  private meta(): (Meta & { readHash: string; writeHash: string }) | null {
    const rows = this.ctx.storage.sql
      .exec<{ id: string; title: string; created_at: number; expires_at: number | null; read_hash: string; write_hash: string }>(
        `SELECT * FROM _artifact LIMIT 1`,
      )
      .toArray();
    const r = rows[0];
    if (!r || (r.expires_at != null && r.expires_at <= Date.now() / 1000)) return null;
    return { id: r.id, title: r.title, createdAt: r.created_at, expiresAt: r.expires_at, readHash: r.read_hash, writeHash: r.write_hash };
  }

  private ensureTable(): void {
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS _artifact (
      id TEXT NOT NULL, title TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER,
      read_hash TEXT NOT NULL, write_hash TEXT NOT NULL,
      read_token TEXT NOT NULL DEFAULT '')`);
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
      `INSERT INTO _artifact VALUES (?, ?, ?, ?, ?, ?, ?)`,
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
    if (timingSafeEqual(h, m.readHash)) return 'read';
    return null;
  }

  /** Run one Fossil op for `caller`. Unknown, expired and forbidden all answer not_found. */
  async op(caller: Caller, request: FossilRequest): Promise<FossilReply<unknown>> {
    const need = NEEDS[request.op];
    const role = await this.role(caller);
    if (!need || !role || (need === 'write' && role !== 'write')) {
      return { error: role === 'read' ? 'this link is read-only' : 'not found', code: role === 'read' ? 'forbidden' : 'not_found' };
    }
    return run<unknown>(this.ctx.storage, request);
  }

  /** Fossil's sync protocol; the repository's own logins decide access. */
  async sync(body: Uint8Array, cookie: string): Promise<FossilReply<{ data: string }>> {
    this.ensureTable();
    if (!this.meta()) return { error: 'not found', code: 'not_found' };
    return run<{ data: string }>(this.ctx.storage, { op: 'sync', cookie }, body);
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
