/**
 * Registry: a single Durable Object listing every artifact, so ids and slugs
 * resolve and the owner can list them. It holds no content.
 */

import { DurableObject } from 'cloudflare:workers';

export interface Entry {
  id: string;
  slug: string | null;
  title: string;
  createdAt: number;
  updatedAt: number;
  expiresAt: number | null;
  tip: string;
}

type Row = { id: string; slug: string | null; title: string; created_at: number; updated_at: number; expires_at: number | null; tip: string };

const now = () => Math.floor(Date.now() / 1000);
const LIVE = '(expires_at IS NULL OR expires_at > ?)';

export class Registry extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY, slug TEXT UNIQUE, title TEXT NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, expires_at INTEGER, tip TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS artifacts_updated ON artifacts (updated_at DESC);
    `);
  }

  /** Claim an id and optional slug. False when the slug is taken by a live artifact. */
  async add(e: Entry): Promise<boolean> {
    const sql = this.ctx.storage.sql;
    if (e.slug != null) {
      if (sql.exec(`SELECT 1 FROM artifacts WHERE slug = ? AND ${LIVE}`, e.slug, now()).toArray().length) return false;
      sql.exec(`DELETE FROM artifacts WHERE slug = ?`, e.slug); // an expired holder gives it up
    }
    sql.exec(`INSERT INTO artifacts VALUES (?, ?, ?, ?, ?, ?, ?)`, e.id, e.slug, e.title, e.createdAt, e.updatedAt, e.expiresAt, e.tip);
    return true;
  }

  async resolve(idOrSlug: string): Promise<string | null> {
    return this.ctx.storage.sql
      .exec<{ id: string }>(`SELECT id FROM artifacts WHERE (id = ? OR slug = ?) AND ${LIVE} LIMIT 1`, idOrSlug, idOrSlug, now())
      .toArray()[0]?.id ?? null;
  }

  async get(id: string): Promise<Entry | null> {
    const r = this.ctx.storage.sql.exec<Row>(`SELECT * FROM artifacts WHERE id = ?`, id).toArray()[0];
    return r ? toEntry(r) : null;
  }

  async touch(id: string, tip: string, title?: string): Promise<void> {
    this.ctx.storage.sql.exec(
      `UPDATE artifacts SET tip = ?, updated_at = ?, title = COALESCE(?, title) WHERE id = ?`,
      tip, now(), title ?? null, id,
    );
  }

  async remove(id: string): Promise<void> {
    this.ctx.storage.sql.exec(`DELETE FROM artifacts WHERE id = ?`, id);
  }

  async list(limit: number): Promise<Entry[]> {
    return this.ctx.storage.sql
      .exec<Row>(`SELECT * FROM artifacts WHERE ${LIVE} ORDER BY updated_at DESC LIMIT ?`, now(), limit)
      .toArray()
      .map(toEntry);
  }
}

function toEntry(r: Row): Entry {
  return { id: r.id, slug: r.slug, title: r.title, createdAt: r.created_at, updatedAt: r.updated_at, expiresAt: r.expires_at, tip: r.tip };
}
