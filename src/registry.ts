import { DurableObject } from 'cloudflare:workers';
import { genId } from './util';
import { deletePublicationFiles, publicationManifest, publicationPrefix } from './publication-files';

export type Publication = {
  id: string; artifactId: string; ownerId: string; title: string; checkin: string;
  createdAt: string; status: 'building' | 'live' | 'failed' | 'deleted'; files: number; bytes: number;
}
const PUBLICATION_COLUMNS = 'id, artifact_id AS artifactId, owner_id AS ownerId, title, checkin, created_at AS createdAt, status, files, bytes';

export interface Entry {
  id: string; slug: string | null; title: string; createdAt: number; updatedAt: number;
  expiresAt: number | null; tip: string; ownerId?: string; archived?: boolean; icon?: string;
}
export type Account = { id: string; email: string; name: string; role: 'owner' | 'member'; status: 'active' | 'invited' | 'disabled' };
type Row = { id: string; slug: string | null; title: string; created_at: number; updated_at: number; expires_at: number | null; tip: string; owner_id: string | null; archived: number; icon: string };
const now = () => Math.floor(Date.now() / 1000);
/** How long an attach may hold its ref pending before reconciling treats it as abandoned (ms). */
const PENDING_MAX = 5 * 60_000;

/**
 * Test-only settings, unset in production: a pause between deciding to delete
 * and deleting, an injected R2 failure or abandoned deletion, and how old a
 * tombstone must be before the next access finishes its deletion (default 5 minutes).
 */
export function testHooks(env: Env): { pause: number; fault: string; staleMs: number } {
  const v = env as unknown as Record<string, string | undefined>;
  // Empty is unset: deploy.sh blanks them.
  return { pause: Number(v.TEST_CLEANUP_PAUSE_MS || 0), fault: v.TEST_CLEANUP_FAULT || '', staleMs: Number(v.TEST_TOMBSTONE_STALE_MS || 300_000) };
}
const LIVE = '(expires_at IS NULL OR expires_at > ?)';

/** How long an owner's or account's upload holds its bytes before it is used (seconds). */
const UNUSED_UPLOAD_HOLD = 24 * 3600;

export class Registry extends DurableObject<Env> {
  /** R2 keys this instance is deleting now (see deleteObjects). */
  private inFlight = new Set<string>();
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY, slug TEXT UNIQUE, title TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, expires_at INTEGER, tip TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS artifacts_updated ON artifacts(updated_at DESC);
      CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL, status TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS logins (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS credentials (id TEXT PRIMARY KEY, hash TEXT UNIQUE NOT NULL, user_id TEXT NOT NULL, name TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS grants (artifact_id TEXT NOT NULL, user_id TEXT NOT NULL, permission TEXT NOT NULL, PRIMARY KEY(artifact_id,user_id));
      CREATE TABLE IF NOT EXISTS stars (artifact_id TEXT NOT NULL, user_id TEXT NOT NULL, PRIMARY KEY(artifact_id,user_id));
      CREATE TABLE IF NOT EXISTS activity (id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, action TEXT NOT NULL, artifact_id TEXT, artifact_title TEXT, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS blob_refs (sha TEXT NOT NULL, artifact_id TEXT NOT NULL, PRIMARY KEY(sha,artifact_id));
      CREATE INDEX IF NOT EXISTS blob_refs_artifact ON blob_refs(artifact_id,sha);
      CREATE TABLE IF NOT EXISTS blob_uploads (sha TEXT NOT NULL, principal TEXT NOT NULL, PRIMARY KEY(sha,principal));
      CREATE TABLE IF NOT EXISTS attachment_refs (sha TEXT NOT NULL, artifact_id TEXT NOT NULL,
        seq INTEGER NOT NULL DEFAULT 0, pending_since INTEGER, PRIMARY KEY(sha,artifact_id));
      CREATE TABLE IF NOT EXISTS attachment_seq (id INTEGER PRIMARY KEY CHECK(id=1), n INTEGER NOT NULL);
      INSERT OR IGNORE INTO attachment_seq VALUES (1,0);
      CREATE INDEX IF NOT EXISTS attachment_refs_artifact ON attachment_refs(artifact_id,sha);
      CREATE TABLE IF NOT EXISTS attachment_objects (artifact_id TEXT NOT NULL, sha TEXT NOT NULL, size INTEGER NOT NULL, uploaded_at INTEGER NOT NULL, PRIMARY KEY(artifact_id,sha));
      CREATE INDEX IF NOT EXISTS attachment_objects_sha ON attachment_objects(sha);
      CREATE TABLE IF NOT EXISTS deleting (key TEXT PRIMARY KEY, deleting_at INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS deleting_at ON deleting(deleting_at);`);
    const cols = sql.exec<{ name: string }>('PRAGMA table_info(artifacts)').toArray();
    if (!sql.exec<{ name: string }>('PRAGMA table_info(blob_uploads)').toArray().some(c => c.name === 'uploaded_at')) {
      // Uploads recorded before these columns count as old: they no longer hold their bytes on their own.
      sql.exec('ALTER TABLE blob_uploads ADD COLUMN uploaded_at INTEGER NOT NULL DEFAULT 0');
      sql.exec('ALTER TABLE blob_uploads ADD COLUMN used INTEGER NOT NULL DEFAULT 0');
    }
    if (!cols.some(c => c.name === 'owner_id')) sql.exec('ALTER TABLE artifacts ADD COLUMN owner_id TEXT');
    if (!cols.some(c => c.name === 'archived')) sql.exec('ALTER TABLE artifacts ADD COLUMN archived INTEGER NOT NULL DEFAULT 0');
    if (!cols.some(c => c.name === 'icon')) sql.exec("ALTER TABLE artifacts ADD COLUMN icon TEXT NOT NULL DEFAULT 'document'");
    sql.exec(`CREATE INDEX IF NOT EXISTS artifacts_name_order ON artifacts(title COLLATE NOCASE,id);
      CREATE INDEX IF NOT EXISTS artifacts_library_order ON artifacts(updated_at DESC,id DESC);
      CREATE INDEX IF NOT EXISTS artifacts_owner ON artifacts(owner_id,archived,updated_at DESC,id DESC);
      CREATE INDEX IF NOT EXISTS grants_user ON grants(user_id,artifact_id);
      CREATE INDEX IF NOT EXISTS stars_user ON stars(user_id,artifact_id);
      CREATE INDEX IF NOT EXISTS activity_order ON activity(created_at DESC,id DESC);
      CREATE TABLE IF NOT EXISTS publications (id TEXT PRIMARY KEY, artifact_id TEXT NOT NULL, owner_id TEXT NOT NULL,
        title TEXT NOT NULL, checkin TEXT NOT NULL, created_at TEXT NOT NULL, status TEXT NOT NULL,
        files INTEGER NOT NULL DEFAULT 0, bytes INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS publications_owner ON publications(owner_id,created_at DESC,id DESC);
      CREATE INDEX IF NOT EXISTS publications_status ON publications(status,created_at);
      CREATE TABLE IF NOT EXISTS publication_cleanup (id INTEGER PRIMARY KEY CHECK(id=1), cursor TEXT NOT NULL);
      INSERT OR IGNORE INTO publication_cleanup VALUES (1,'');`);
  }
  async beginPublication(artifactId: string, ownerId: string, title: string, checkin: string): Promise<Publication> {
    let id: string;
    do { id = genId().slice(0, 12); } while (await this.publication(id));
    this.ctx.storage.sql.exec("INSERT INTO publications (id,artifact_id,owner_id,title,checkin,created_at,status) VALUES (?,?,?,?,?,?,'building')",
      id, artifactId, ownerId, title, checkin, new Date().toISOString());
    return (await this.publication(id))!;
  }
  async publication(id: string): Promise<Publication | null> {
    return this.ctx.storage.sql.exec<Publication>(`SELECT ${PUBLICATION_COLUMNS} FROM publications WHERE id=?`, id).toArray()[0] ?? null;
  }
  async publications(ownerId: string | null, artifactId: string | null, cursor: string | null): Promise<{ publications: Publication[]; nextCursor: string | null }> {
    const rows = this.ctx.storage.sql.exec<Publication>(`SELECT ${PUBLICATION_COLUMNS} FROM publications
      WHERE status != 'deleted' AND (? IS NULL OR owner_id=?) AND (? IS NULL OR artifact_id=?)
      AND (? IS NULL OR created_at || '/' || id < ?) ORDER BY created_at DESC,id DESC LIMIT 51`,
      ownerId, ownerId, artifactId, artifactId, cursor, cursor).toArray();
    const page = rows.slice(0, 50), last = page.at(-1);
    return { publications: page, nextCursor: rows.length > 50 && last ? `${last.createdAt}/${last.id}` : null };
  }
  /** Marker activation and revocation are serialized, not the potentially large file copy. */
  async activatePublication(id: string, entry: string, files: number, bytes: number): Promise<Publication | null> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const row = await this.publication(id);
      if (!row || row.status !== 'building' || Date.parse(row.createdAt) < Date.now() - 3600_000) return null;
      await this.env.BLOBS.put(publicationManifest(id), JSON.stringify({ entry }), { httpMetadata: { contentType: 'application/json' } });
      this.ctx.storage.sql.exec("UPDATE publications SET status='live',files=?,bytes=? WHERE id=?", files, bytes, id);
      return this.publication(id);
    });
  }
  async failPublication(id: string): Promise<void> {
    this.ctx.storage.sql.exec("UPDATE publications SET status='failed' WHERE id=? AND status='building'", id);
  }
  async revokePublication(id: string): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      await this.env.BLOBS.delete(publicationManifest(id));
      this.ctx.storage.sql.exec("UPDATE publications SET status='deleted' WHERE id=?", id);
    });
    await deletePublicationFiles(this.env.BLOBS, id);
  }
  async cleanupPublications(): Promise<{ cleaned: number; remaining: boolean }> {
    const sql = this.ctx.storage.sql;
    const cursor = sql.exec<{ cursor: string }>('SELECT cursor FROM publication_cleanup WHERE id=1').toArray()[0]!.cursor;
    // Revisit tombstones on every pass: a cancelled writer can land a late R2 put
    // even after its first cleanup, and may die before its cancellation handler.
    const rows = sql.exec<{ id: string; status: string }>(`SELECT id,status FROM publications WHERE id > ? AND
      (status IN ('failed','deleted') OR (status='building' AND created_at < ?))
      ORDER BY id LIMIT 26`, cursor, new Date(Date.now() - 3600_000).toISOString()).toArray();
    let cleaned = 0;
    for (const row of rows.slice(0, 25)) {
      const hadFiles = (await this.env.BLOBS.list({ prefix: publicationPrefix(row.id), limit: 1 })).objects.length > 0;
      await this.revokePublication(row.id);
      if (hadFiles || row.status !== 'deleted') cleaned++;
    }
    const remaining = rows.length > 25;
    // Compare-and-set avoids concurrent cleanup calls moving the pass backward.
    sql.exec('UPDATE publication_cleanup SET cursor=? WHERE id=1 AND cursor=?', remaining ? rows[24]!.id : '', cursor);
    return { cleaned, remaining };
  }
  async seed(email: string): Promise<void> {
    if (!email) return;
    this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      const owner = sql.exec<Account>("SELECT * FROM accounts WHERE id='instance-owner'").toArray()[0];
      if (owner && owner.email !== email) {
        for (const table of ['sessions','logins','credentials']) sql.exec(`DELETE FROM ${table} WHERE user_id='instance-owner'`);
        // A UNIQUE collision with a member fails closed rather than silently
        // promoting that member or merging two accounts' access.
        sql.exec("UPDATE accounts SET email=?, name='Instance owner' WHERE id='instance-owner'",email);
      } else if (!owner) sql.exec("INSERT INTO accounts VALUES ('instance-owner', ?, 'Instance owner', 'owner', 'active')",email);
    });
  }
  async add(e: Entry): Promise<boolean> {
    const sql = this.ctx.storage.sql;
    if (e.slug != null) {
      if (sql.exec(`SELECT 1 FROM artifacts WHERE slug = ? AND ${LIVE}`, e.slug, now()).toArray().length) return false;
      sql.exec('DELETE FROM artifacts WHERE slug = ?', e.slug);
    }
    sql.exec('INSERT INTO artifacts (id,slug,title,created_at,updated_at,expires_at,tip,owner_id,icon) VALUES (?,?,?,?,?,?,?,?,?)', e.id,e.slug,e.title,e.createdAt,e.updatedAt,e.expiresAt,e.tip,e.ownerId ?? 'instance-owner',e.icon ?? 'document');
    return true;
  }
  async resolve(key: string): Promise<string | null> {
    return this.ctx.storage.sql.exec<{ id: string }>(`SELECT id FROM artifacts WHERE (id = ? OR slug = ?) AND ${LIVE} LIMIT 1`,key,key,now()).toArray()[0]?.id ?? null;
  }
  async get(id: string): Promise<Entry | null> {
    const r = this.ctx.storage.sql.exec<Row>('SELECT * FROM artifacts WHERE id = ?', id).toArray()[0];
    return r ? toEntry(r) : null;
  }
  async touch(id: string, tip?: string, title?: string, icon?: string | null): Promise<void> {
    this.ctx.storage.sql.exec('UPDATE artifacts SET tip = COALESCE(?,tip), updated_at = ?, title = COALESCE(?,title), icon = COALESCE(?,icon) WHERE id = ?',tip ?? null,now(),title ?? null,icon === null ? 'document' : icon ?? null,id);
  }
  /**
   * Delete an artifact's listing, and the R2 objects no other artifact points
   * at: check-in blobs under b/ and attachments under attachments/.
   */
  async remove(id: string): Promise<void> {
    const orphans = this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      for (const table of ['grants','stars']) sql.exec(`DELETE FROM ${table} WHERE artifact_id = ?`,id);
      sql.exec('DELETE FROM artifacts WHERE id = ?',id);
      const shasOf = (q: string) => sql.exec<{ sha: string }>(q,id).toArray().map(r => r.sha);
      // What the artifact points at, and what was uploaded to it but never used.
      const blobs = new Set([...shasOf('SELECT sha FROM blob_refs WHERE artifact_id = ?'),
        ...shasOf("SELECT sha FROM blob_uploads WHERE principal = 'artifact:' || ?")]);
      const attachments = new Set([...shasOf('SELECT sha FROM attachment_refs WHERE artifact_id = ?'),
        ...shasOf('SELECT sha FROM attachment_objects WHERE artifact_id = ?')]);
      for (const table of ['blob_refs','attachment_refs','attachment_objects']) sql.exec(`DELETE FROM ${table} WHERE artifact_id = ?`,id);
      sql.exec('DELETE FROM blob_uploads WHERE principal IN (?,?)',`artifact:${id}`,`attachment:${id}`);
      const used = (q: string, sha: string) => sql.exec(q,sha).toArray().length > 0;
      return this.tombstone([
        // A blob lives as long as some artifact points at it, another artifact holds an upload of
        // it (which its tree, pushed from a clone, may name before anyone views it), or someone
        // uploaded it within a day and has not used it yet.
        ...[...blobs].filter(sha => !used('SELECT 1 FROM blob_refs WHERE sha = ? LIMIT 1',sha) &&
          !sql.exec(`SELECT 1 FROM blob_uploads WHERE sha = ? AND principal NOT LIKE 'attachment:%'
            AND (principal LIKE 'artifact:%' OR (uploaded_at > ? AND NOT used)) LIMIT 1`,sha,now() - UNUSED_UPLOAD_HOLD).toArray().length).map(sha => `b/${sha}`),
        ...[...attachments].filter(sha => !this.attachmentHeld(sha)).map(sha => `attachments/${sha}`),
      ]);
    });
    await this.deleteObjects(orphans);
  }
  /**
   * Mark R2 keys as being deleted, inside the transaction that decided it.
   * Until deleteObjects clears the mark, nothing may refer to them again:
   * refs skip them, uploads are refused, and checks treat them as missing.
   */
  private tombstone(keys: string[]): string[] {
    for (const key of keys) this.ctx.storage.sql.exec('INSERT OR IGNORE INTO deleting VALUES (?,?)',key,Date.now());
    return keys;
  }
  /**
   * Delete R2 keys tombstoned by the transaction that decided to, then clear
   * their tombstones. If R2 refuses, the tombstones are cleared anyway: the
   * bytes are still there, and usable again. If the object is evicted midway,
   * settleStale finishes the job.
   */
  private async deleteObjects(keys: string[]): Promise<void> {
    if (!keys.length) return;
    const test = testHooks(this.env);
    if (test.fault === 'abandon') {
      if (test.pause > 0) await new Promise(r => setTimeout(r, test.pause));
      return;
    }
    // Running here: settleStale leaves these alone however long R2 takes. An
    // eviction drops the set, and with it the claim, as it drops the deletion.
    for (const key of keys) this.inFlight.add(key);
    try {
      if (test.pause > 0) await new Promise(r => setTimeout(r, test.pause));
      if (test.fault === 'throw') throw new Error('injected R2 failure');
      for (let i = 0; i < keys.length; i += 1000) await this.env.BLOBS.delete(keys.slice(i, i + 1000));
    } catch (e) {
      console.error(`registry: could not delete ${keys.length} R2 objects; they stay: ${String(e)}`);
    } finally {
      for (const key of keys) {
        this.ctx.storage.sql.exec('DELETE FROM deleting WHERE key = ?',key);
        this.inFlight.delete(key);
      }
    }
  }
  /** Finish deletions left tombstoned longer than a deletion can take: delete again (idempotent), then clear. */
  private async settleStale(): Promise<void> {
    const stale = this.ctx.storage.sql.exec<{ key: string }>('SELECT key FROM deleting WHERE deleting_at < ? LIMIT 1000',
      Date.now() - testHooks(this.env).staleMs).toArray().map(r => r.key).filter(key => !this.inFlight.has(key));
    if (!stale.length) return;
    await this.env.BLOBS.delete(stale);
    for (const key of stale) this.ctx.storage.sql.exec('DELETE FROM deleting WHERE key = ?',key);
  }
  private isDeleting(key: string): boolean {
    return this.ctx.storage.sql.exec('SELECT 1 FROM deleting WHERE key = ?',key).toArray().length > 0;
  }
  /** Whether R2 key `space/sha` is being deleted: uploads to it must wait. */
  async deletingObject(key: string): Promise<boolean> {
    await this.settleStale();
    return this.isDeleting(key);
  }
  /**
   * Record that artifact `id` points at these blobs (idempotent), and return
   * the ones it now points at: never a blob being deleted.
   */
  async refBlobs(id: string, shas: string[]): Promise<string[]> {
    await this.settleStale();
    return [...new Set(shas)].filter(sha => {
      if (this.isDeleting(`b/${sha}`)) return false;
      this.ctx.storage.sql.exec('INSERT OR IGNORE INTO blob_refs VALUES (?,?)',sha,id);
      return true;
    });
  }
  /**
   * `principal` (artifact:<id>, attachment:<id>, user:<id> or owner) sent these
   * exact bytes, stored at `key`. False when they are being deleted.
   */
  async recordUpload(sha: string, principal: string, key = `b/${sha}`): Promise<boolean> {
    await this.settleStale();
    if (this.isDeleting(key)) return false;
    this.ctx.storage.sql.exec(`INSERT INTO blob_uploads (sha,principal,uploaded_at,used) VALUES (?,?,?,0)
      ON CONFLICT(sha,principal) DO UPDATE SET uploaded_at = excluded.uploaded_at, used = 0`,sha,principal,now());
    return true;
  }
  /**
   * The blobs among `shas` that artifact `id` may point at: ones it already
   * points at, or ones one of `principals` uploaded. Knowing a hash is not
   * enough to reach someone else's bytes.
   */
  /**
   * An owner's or account's uploads of `shas` are used: an artifact points at
   * them now. They still let the uploader reuse the bytes, but no longer hold
   * them on their own; uploading them again does, for another day.
   */
  async consumeUploads(principal: string, shas: string[]): Promise<void> {
    if (principal.startsWith('artifact:') || principal.startsWith('attachment:')) return;
    for (const sha of shas) this.ctx.storage.sql.exec('UPDATE blob_uploads SET used = 1 WHERE sha = ? AND principal = ?',sha,principal);
  }
  async allowedBlobs(id: string, principals: string[], shas: string[]): Promise<string[]> {
    await this.settleStale();
    const sql = this.ctx.storage.sql;
    return [...new Set(shas)].filter(sha => !this.isDeleting(`b/${sha}`) && (
      sql.exec('SELECT 1 FROM blob_refs WHERE sha = ? AND artifact_id = ?',sha,id).toArray().length ||
      principals.some(p => sql.exec('SELECT 1 FROM blob_uploads WHERE sha = ? AND principal = ?',sha,p).toArray().length)));
  }
  /** The next number in the order refs are made and confirmed; never reused. */
  private nextSeq(): number {
    return this.ctx.storage.sql.exec<{ n: number }>('UPDATE attachment_seq SET n = n + 1 WHERE id = 1 RETURNING n').toArray()[0]!.n;
  }
  /**
   * Record that artifact `id` attaches these bytes, skipping any being deleted.
   * `pending` marks an attach whose write has not happened yet: reconciling
   * never drops a pending ref (confirmAttachments ends it). Returns the ones it
   * now refers to, and which of those are new.
   */
  async refAttachments(id: string, shas: string[], pending = false): Promise<{ refs: string[]; added: string[] }> {
    await this.settleStale();
    return this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql, refs: string[] = [], added: string[] = [];
      for (const sha of new Set(shas)) {
        if (this.isDeleting(`attachments/${sha}`)) continue;
        refs.push(sha);
        if (!sql.exec('SELECT 1 FROM attachment_refs WHERE sha = ? AND artifact_id = ?',sha,id).toArray().length) added.push(sha);
        sql.exec(`INSERT INTO attachment_refs VALUES (?,?,?,?) ON CONFLICT(sha,artifact_id) DO UPDATE SET seq = excluded.seq,
          pending_since = coalesce(excluded.pending_since, pending_since)`,sha,id,this.nextSeq(),pending ? Date.now() : null);
      }
      return { refs, added };
    });
  }
  /** The attach these refs were pending for has written (or given up): renumber them as of now. */
  async confirmAttachments(id: string, shas: string[]): Promise<void> {
    this.ctx.storage.transactionSync(() => {
      for (const sha of shas) this.ctx.storage.sql.exec('UPDATE attachment_refs SET pending_since = NULL, seq = ? WHERE sha = ? AND artifact_id = ?',this.nextSeq(),sha,id);
    });
  }
  /** Drop refs an attach that failed added: the bytes are an unattached upload again. */
  async unrefAttachments(id: string, shas: string[]): Promise<void> {
    for (const sha of shas) this.ctx.storage.sql.exec('DELETE FROM attachment_refs WHERE sha = ? AND artifact_id = ?',sha,id);
  }
  /** Taken before reading an artifact's current attachments: reconcileAttachments drops no ref made or confirmed after it. */
  async attachmentMark(): Promise<number> {
    return this.ctx.storage.sql.exec<{ n: number }>('SELECT n FROM attachment_seq WHERE id = 1').toArray()[0]!.n;
  }
  /**
   * Bring artifact `id`'s attachment bookkeeping in line with `current`, the
   * R2 bytes its attachments named when read after `mark`: bytes it attached
   * before but names no longer stop counting against its quota, and are
   * deleted unless another artifact holds them. A ref made or confirmed after
   * `mark`, or pending (for at most PENDING_MAX), may name bytes the read
   * did not see yet, and stays.
   */
  async reconcileAttachments(id: string, current: string[], mark: number): Promise<void> {
    const keep = new Set(current);
    const orphans = this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      const gone = sql.exec<{ sha: string }>(`SELECT sha FROM attachment_refs WHERE artifact_id = ? AND seq <= ?
        AND (pending_since IS NULL OR pending_since < ?)`,id,mark,Date.now() - PENDING_MAX).toArray().map(r => r.sha).filter(sha => !keep.has(sha));
      for (const sha of gone) {
        sql.exec('DELETE FROM attachment_refs WHERE sha = ? AND artifact_id = ?',sha,id);
        sql.exec('DELETE FROM attachment_objects WHERE sha = ? AND artifact_id = ?',sha,id);
        sql.exec('DELETE FROM blob_uploads WHERE sha = ? AND principal = ?',sha,`attachment:${id}`);
      }
      return this.tombstone(gone.filter(sha => !this.attachmentHeld(sha)).map(sha => `attachments/${sha}`));
    });
    await this.deleteObjects(orphans);
  }
  /**
   * The attachment bytes among `shas` that artifact `id` may name: ones it
   * already names, or ones uploaded to it (principal attachment:<id>).
   */
  async allowedAttachments(id: string, shas: string[]): Promise<string[]> {
    await this.settleStale();
    const sql = this.ctx.storage.sql;
    return [...new Set(shas)].filter(sha => !this.isDeleting(`attachments/${sha}`) && (
      sql.exec('SELECT 1 FROM attachment_refs WHERE sha = ? AND artifact_id = ?',sha,id).toArray().length ||
      sql.exec('SELECT 1 FROM blob_uploads WHERE sha = ? AND principal = ?',sha,`attachment:${id}`).toArray().length));
  }
  /** Whether any artifact still attaches or holds an upload of these attachment bytes. */
  private attachmentHeld(sha: string): boolean {
    const sql = this.ctx.storage.sql;
    return sql.exec('SELECT 1 FROM attachment_refs WHERE sha = ? LIMIT 1',sha).toArray().length > 0 ||
      sql.exec('SELECT 1 FROM attachment_objects WHERE sha = ? LIMIT 1',sha).toArray().length > 0;
  }
  /**
   * Count `size` bytes against artifact `id`'s attachment quota before they are
   * uploaded: 'held' when it already holds them, 'reserved' when they fit, 'over'
   * when they would take it past `max`. A reservation is released if the upload fails.
   */
  async reserveAttachment(id: string, sha: string, size: number, max: number): Promise<'held' | 'reserved' | 'over'> {
    return this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      if (sql.exec('SELECT 1 FROM attachment_objects WHERE artifact_id = ? AND sha = ?',id,sha).toArray().length) return 'held';
      const used = sql.exec<{ n: number }>('SELECT coalesce(sum(size),0) AS n FROM attachment_objects WHERE artifact_id = ?',id).toArray()[0]!.n;
      if (used + size > max) return 'over';
      sql.exec('INSERT INTO attachment_objects VALUES (?,?,?,?)',id,sha,size,now());
      return 'reserved';
    });
  }
  async releaseAttachment(id: string, sha: string): Promise<void> {
    this.ctx.storage.sql.exec('DELETE FROM attachment_objects WHERE artifact_id = ? AND sha = ?',id,sha);
  }
  /**
   * Forget artifact `id`'s attachment uploads older than `maxAge` seconds that
   * no thread attaches, and delete the bytes no artifact holds any more.
   */
  async sweepAttachmentUploads(id: string, maxAge: number, current: string[]): Promise<void> {
    const named = new Set(current);
    const orphans = this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      const stale = sql.exec<{ sha: string }>(`SELECT sha FROM attachment_objects WHERE artifact_id = ? AND uploaded_at < ?
        AND sha NOT IN (SELECT sha FROM attachment_refs WHERE artifact_id = ?)`,id,now() - maxAge,id).toArray().map(r => r.sha)
        .filter(sha => !named.has(sha));
      for (const sha of stale) {
        sql.exec('DELETE FROM attachment_objects WHERE artifact_id = ? AND sha = ?',id,sha);
        sql.exec('DELETE FROM blob_uploads WHERE sha = ? AND principal = ?',sha,`attachment:${id}`);
      }
      return this.tombstone(stale.filter(sha => !this.attachmentHeld(sha)).map(sha => `attachments/${sha}`));
    });
    await this.deleteObjects(orphans);
  }
  async hasAttachment(id: string, sha: string): Promise<boolean> {
    return this.ctx.storage.sql.exec('SELECT 1 FROM attachment_refs WHERE sha = ? AND artifact_id = ?',sha,id).toArray().length > 0;
  }
  async hasBlob(id: string, sha: string): Promise<boolean> {
    return this.ctx.storage.sql.exec('SELECT 1 FROM blob_refs WHERE sha = ? AND artifact_id = ?',sha,id).toArray().length > 0;
  }
  async list(limit: number): Promise<Entry[]> {
    return this.ctx.storage.sql.exec<Row>(`SELECT * FROM artifacts WHERE ${LIVE} ORDER BY updated_at DESC LIMIT ?`,now(),limit).toArray().map(toEntry);
  }
  async account(id: string): Promise<Account | null> { return this.ctx.storage.sql.exec<Account>('SELECT * FROM accounts WHERE id = ?',id).toArray()[0] ?? null; }
  async byEmail(email: string): Promise<Account | null> { return this.ctx.storage.sql.exec<Account>('SELECT * FROM accounts WHERE email = ?',email).toArray()[0] ?? null; }
  async people(): Promise<Account[]> { return this.ctx.storage.sql.exec<Account>('SELECT * FROM accounts ORDER BY email LIMIT 1000').toArray(); }
  async invite(email: string, name: string): Promise<Account> {
    this.ctx.storage.sql.exec(`INSERT OR IGNORE INTO accounts VALUES (?, ?, ?, 'member', 'invited')`,genId(),email,name);
    return (await this.byEmail(email))!;
  }
  async status(id: string, status: string): Promise<void> {
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(`UPDATE accounts SET status = ? WHERE id = ? AND role != 'owner'`,status,id);
      if (status === 'disabled') {
        for (const t of ['sessions','credentials','logins']) this.ctx.storage.sql.exec(`DELETE FROM ${t} WHERE user_id = ?`,id);
      }
    });
  }
  /** Count one attempt against each of `keys`: false once any has had `limit` within its `window` seconds. */
  async rate(keys: string[], limit = 5, window = 900): Promise<boolean> {
    return this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      sql.exec('DELETE FROM rate_limits WHERE expires <= ?',now());
      const allowed = keys.every(key => (sql.exec<{ count: number }>('SELECT count FROM rate_limits WHERE key = ?',key).toArray()[0]?.count ?? 0) < limit);
      if (allowed) for (const key of keys) sql.exec('INSERT INTO rate_limits VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1',key,now()+window);
      return allowed;
    });
  }
  async login(hash: string, userId: string): Promise<void> {
    this.ctx.storage.sql.exec('DELETE FROM logins WHERE expires <= ?',now());
    this.ctx.storage.sql.exec('INSERT INTO logins VALUES (?,?,?)',hash,userId,now()+900);
  }
  async verify(hash: string, sessionHash: string): Promise<Account | null> {
    return this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      const token = sql.exec<{ user_id: string }>('DELETE FROM logins WHERE hash = ? AND expires > ? RETURNING user_id',hash,now()).toArray()[0];
      if (!token) return null;
      const user = sql.exec<Account>(`SELECT * FROM accounts WHERE id = ? AND status IN ('active','invited')`,token.user_id).toArray()[0];
      if (!user) return null;
      sql.exec(`UPDATE accounts SET status = 'active' WHERE id = ?`,user.id);
      sql.exec('DELETE FROM sessions WHERE expires <= ?',now());
      sql.exec('INSERT INTO sessions VALUES (?,?,?)',sessionHash,user.id,now()+604800);
      return { ...user, status: 'active' };
    });
  }
  async authenticate(hash: string, credential = false): Promise<Account | null> {
    const sql = this.ctx.storage.sql;
    return sql.exec<Account>(`SELECT a.* FROM accounts a JOIN ${credential ? 'credentials' : 'sessions'} s ON s.user_id=a.id WHERE s.hash=? AND a.status='active' ${credential ? '' : 'AND s.expires > ?'}`, ... (credential ? [hash] : [hash,now()])).toArray()[0] ?? null;
  }
  async discardLogin(hash: string): Promise<void> { this.ctx.storage.sql.exec('DELETE FROM logins WHERE hash = ?',hash); }
  async logout(hash: string): Promise<void> { this.ctx.storage.sql.exec('DELETE FROM sessions WHERE hash = ?',hash); }
  async credentials(userId: string) {
    return this.ctx.storage.sql.exec<{ id: string; name: string; createdAt: number }>('SELECT id,name,created_at AS createdAt FROM credentials WHERE user_id=? ORDER BY created_at DESC LIMIT 100',userId).toArray();
  }
  async credential(userId: string, id: string, name: string, hash: string): Promise<boolean> {
    return this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      const count = sql.exec<{ n: number }>('SELECT count(*) AS n FROM credentials WHERE user_id=?',userId).one().n;
      if (count >= 100) return false;
      sql.exec('INSERT INTO credentials VALUES (?,?,?,?,?)',id,hash,userId,name,now());
      return true;
    });
  }
  async revoke(userId: string, id: string): Promise<void> { this.ctx.storage.sql.exec('DELETE FROM credentials WHERE user_id=? AND id=?',userId,id); }
  async permission(id: string, user: Account): Promise<'read' | 'write' | null> {
    const e = await this.get(id);
    if (!e) return null;
    if (user.role === 'owner' || e.ownerId === user.id) return 'write';
    return this.ctx.storage.sql.exec<{ permission: 'read' | 'write' }>('SELECT permission FROM grants WHERE artifact_id=? AND user_id=?',id,user.id).toArray()[0]?.permission ?? null;
  }
  async sharing(id: string) {
    return this.ctx.storage.sql.exec<{ userId: string; email: string; name: string; permission: 'read' | 'write' }>('SELECT a.id AS userId,a.email,a.name,g.permission FROM grants g JOIN accounts a ON a.id=g.user_id WHERE artifact_id=?',id).toArray();
  }
  async grant(id: string, userId: string, permission: string | null): Promise<void> {
    if (permission) this.ctx.storage.sql.exec('INSERT INTO grants VALUES (?,?,?) ON CONFLICT(artifact_id,user_id) DO UPDATE SET permission=excluded.permission',id,userId,permission);
    else this.ctx.storage.sql.exec('DELETE FROM grants WHERE artifact_id=? AND user_id=?',id,userId);
  }
  async manage(id: string, changes: { archived?: boolean; ownerId?: string; title?: string }): Promise<void> {
    this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      sql.exec('UPDATE artifacts SET archived=COALESCE(?,archived),owner_id=COALESCE(?,owner_id),title=COALESCE(?,title),updated_at=? WHERE id=?',changes.archived === undefined ? null : Number(changes.archived),changes.ownerId ?? null,changes.title ?? null,now(),id);
      if (changes.ownerId) sql.exec('DELETE FROM grants WHERE artifact_id=?',id);
    });
  }
  async star(id: string, userId: string, starred: boolean): Promise<void> {
    this.ctx.storage.sql.exec(starred ? 'INSERT OR IGNORE INTO stars VALUES (?,?)' : 'DELETE FROM stars WHERE artifact_id=? AND user_id=?',id,userId);
  }
  async library(user: Account, opts: { admin: boolean; view: string; q: string; ownerId: string; status: string; cursor: string; limit: number; sort?: 'recent' | 'name' }) {
    const clauses = [`${LIVE.replaceAll('expires_at','a.expires_at')}`];
    const args: (string | number)[] = [user.id,user.id,now()];
    if (!opts.admin) {
      clauses.push('a.archived=?'); args.push(opts.view === 'archived' ? 1 : 0);
      if (user.role !== 'owner') { clauses.push("(COALESCE(a.owner_id,'instance-owner')=? OR g.permission IS NOT NULL)"); args.push(user.id); }
      if (opts.view === 'mine') { clauses.push("COALESCE(a.owner_id,'instance-owner')=?"); args.push(user.id); }
      if (opts.view === 'shared') { clauses.push("COALESCE(a.owner_id,'instance-owner')!=? AND g.permission IS NOT NULL"); args.push(user.id); }
      if (opts.view === 'starred') clauses.push('s.user_id IS NOT NULL');
    } else {
      if (opts.status !== 'all') { clauses.push('a.archived=?'); args.push(opts.status === 'archived' ? 1 : 0); }
      if (opts.ownerId) { clauses.push("COALESCE(a.owner_id,'instance-owner')=?"); args.push(opts.ownerId); }
    }
    if (opts.q) { clauses.push("instr(lower(a.title),lower(?)) > 0"); args.push(opts.q); }
    const joins = "FROM artifacts a LEFT JOIN accounts u ON u.id=COALESCE(a.owner_id,'instance-owner') LEFT JOIN grants g ON g.artifact_id=a.id AND g.user_id=? LEFT JOIN stars s ON s.artifact_id=a.id AND s.user_id=?";
    const total = this.ctx.storage.sql.exec<{ n: number }>(`SELECT count(*) AS n ${joins} WHERE ${clauses.join(' AND ')}`,...args).one().n;
    // SQLite NOCASE folds ASCII only, not locale-specific Unicode ordering.
    // Keep the same collation and ID tie-breaker in the seek and ORDER BY.
    const byName = opts.sort === 'name';
    if (opts.cursor) {
      const values = JSON.parse(opts.cursor);
      if (byName) {
        const [,title,id] = values;
        clauses.push('(a.title COLLATE NOCASE > ? OR (a.title COLLATE NOCASE = ? AND a.id > ?))'); args.push(title,title,id);
      } else {
        const [time,id] = values;
        clauses.push('(a.updated_at < ? OR (a.updated_at=? AND a.id < ?))'); args.push(time,time,id);
      }
    }
    const rows = this.ctx.storage.sql.exec<Row & { ownerName: string; starred: number; permission: 'read' | 'write'; shared: number }>(`SELECT a.*,u.name AS ownerName,s.user_id IS NOT NULL AS starred, g.permission, EXISTS(SELECT 1 FROM grants x WHERE x.artifact_id=a.id) AS shared ${joins} WHERE ${clauses.join(' AND ')} ORDER BY ${byName ? 'a.title COLLATE NOCASE ASC,a.id ASC' : 'a.updated_at DESC,a.id DESC'} LIMIT ?`,...args,opts.limit+1).toArray();
    const more = rows.length > opts.limit; rows.splice(opts.limit);
    const last = rows.at(-1);
    return { artifacts: rows.map(r => ({ ...toEntry(r), ownerName: r.ownerName ?? 'Instance owner', accessLabel: (r.owner_id ?? 'instance-owner') === user.id ? (r.shared ? 'Shared by you' : 'Private') : (user.role === 'owner' || r.permission === 'write' ? 'Can edit' : 'Can view'), starred: !!r.starred, permission: user.role === 'owner' || (r.owner_id ?? 'instance-owner') === user.id ? 'write' as const : r.permission, canManage: user.role === 'owner' || (r.owner_id ?? 'instance-owner') === user.id, visibility: r.shared ? 'shared' : 'private' })), total, nextCursor: more && last ? JSON.stringify(byName ? ['name',last.title,last.id] : [last.updated_at,last.id]) : null };
  }
  async audit(userId: string, action: string, id: string | null = null, title: string | null = null): Promise<void> {
    this.ctx.storage.sql.exec('INSERT INTO activity VALUES (?,?,?,?,?,?)',genId(),userId,action,id,title,now());
  }
  async activity(limit: number) {
    return this.ctx.storage.sql.exec<{ id: string; actorName: string; action: string; artifactId: string | null; artifactTitle: string | null; createdAt: number }>('SELECT e.id,a.name AS actorName,e.action,e.artifact_id AS artifactId,e.artifact_title AS artifactTitle,e.created_at AS createdAt FROM activity e LEFT JOIN accounts a ON a.id=e.actor_id ORDER BY e.created_at DESC,e.id DESC LIMIT ?',limit).toArray();
  }
}
function toEntry(r: Row): Entry { return { id:r.id,slug:r.slug,title:r.title,createdAt:r.created_at,updatedAt:r.updated_at,expiresAt:r.expires_at,tip:r.tip,ownerId:r.owner_id ?? 'instance-owner',archived:!!r.archived,icon:r.icon ?? 'document' }; }
