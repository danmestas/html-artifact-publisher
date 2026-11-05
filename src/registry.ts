import { DurableObject } from 'cloudflare:workers';
import { genId, isoOrNull } from './util';
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
export type Account = { id: string; email: string; name: string; role: 'owner' | 'member'; status: 'active' | 'invited' | 'disabled'; created_at?: number | null; signed_in_at?: number | null };
type Row = { id: string; slug: string | null; title: string; created_at: number; updated_at: number; expires_at: number | null; tip: string; owner_id: string | null; archived: number; icon: string };
const now = () => Math.floor(Date.now() / 1000);
/** How long a sign-in link works, in seconds. The mail and the sign-in page state the same figure. */
export const LOGIN_TTL = 3600;
/** How long an attach may hold its ref pending before reconciling treats it as abandoned (ms). */
const PENDING_MAX = 5 * 60_000;

/**
 * Test-only settings, unset in production: a pause between deciding to delete
 * and deleting, an injected R2 failure or abandoned deletion, how old a
 * tombstone must be before the next access finishes its deletion (default 5
 * minutes), and how long an unused upload holds its bytes (default a day).
 */
export function testHooks(env: Env): { pause: number; fault: string; staleMs: number; holdSeconds: number } {
  const v = env as unknown as Record<string, string | undefined>;
  // Empty is unset: deploy.sh blanks them.
  return {
    pause: Number(v.TEST_CLEANUP_PAUSE_MS || 0), fault: v.TEST_CLEANUP_FAULT || '', staleMs: Number(v.TEST_TOMBSTONE_STALE_MS || 300_000),
    holdSeconds: v.TEST_UPLOAD_HOLD_MS ? Number(v.TEST_UPLOAD_HOLD_MS) / 1000 : UNUSED_UPLOAD_HOLD,
  };
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
      CREATE TABLE IF NOT EXISTS activity (id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, action TEXT NOT NULL, artifact_id TEXT, artifact_title TEXT, created_at INTEGER NOT NULL, details TEXT);
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
    // When an account was invited (null for accounts that predate the column), and whom an audited action was about.
    if (!sql.exec<{ name: string }>('PRAGMA table_info(accounts)').toArray().some(c => c.name === 'created_at')) sql.exec('ALTER TABLE accounts ADD COLUMN created_at INTEGER');
    // When the account last completed a sign-in: reactivating one that never did restores "invited".
    // Accounts that were already active when the column arrived count as having signed in.
    if (!sql.exec<{ name: string }>('PRAGMA table_info(accounts)').toArray().some(c => c.name === 'signed_in_at')) {
      sql.exec('ALTER TABLE accounts ADD COLUMN signed_in_at INTEGER');
      sql.exec("UPDATE accounts SET signed_in_at = COALESCE(created_at, 0) WHERE status != 'invited'");
    }
    if (!sql.exec<{ name: string }>('PRAGMA table_info(activity)').toArray().some(c => c.name === 'target')) sql.exec('ALTER TABLE activity ADD COLUMN target TEXT');
    // Structured metadata for an event (an expiration's deadline, for one).
    // Rows written before this column have none: their date is unknown, which
    // stays distinct from a structured "never expires" ({\"expiresAt\":null}).
    if (!sql.exec<{ name: string }>('PRAGMA table_info(activity)').toArray().some(c => c.name === 'details')) sql.exec('ALTER TABLE activity ADD COLUMN details TEXT');
    if (!cols.some(c => c.name === 'archived')) sql.exec('ALTER TABLE artifacts ADD COLUMN archived INTEGER NOT NULL DEFAULT 0');
    if (!cols.some(c => c.name === 'icon')) sql.exec("ALTER TABLE artifacts ADD COLUMN icon TEXT NOT NULL DEFAULT 'document'");
    // The newest expiration revision the Repo has projected here. A repeated
    // projection of the same revision is a no-op, and an older one is refused.
    if (!cols.some(c => c.name === 'expiration_revision')) sql.exec('ALTER TABLE artifacts ADD COLUMN expiration_revision INTEGER NOT NULL DEFAULT 0');
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
      } else if (!owner) sql.exec("INSERT INTO accounts (id,email,name,role,status,created_at) VALUES ('instance-owner', ?, 'Instance owner', 'owner', 'active', ?)",email,now());
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
   *
   * `context.reason === 'expired'` records the automatic expiry in the same
   * transaction as the removal, and only when the row is still there: a retry
   * after a lost acknowledgement finds nothing and adds no second event. The
   * event keeps the title and the reason after the listing row is gone.
   */
  async remove(id: string, context?: { reason?: 'expired'; expiresAt?: number | null; title?: string | null }): Promise<void> {
    const orphans = this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      if (context?.reason === 'expired') {
        const row = sql.exec<{ title: string; expires_at: number | null }>('SELECT title, expires_at FROM artifacts WHERE id = ?',id).toArray()[0];
        if (row) {
          sql.exec('INSERT INTO activity (id,actor_id,action,artifact_id,artifact_title,created_at,target,details) VALUES (?,?,?,?,?,?,?,?)',
            genId(),'system','expired',id,context.title ?? row.title,now(),null,
            JSON.stringify({ reason:'expired', expiresAt: isoOrNull(context.expiresAt !== undefined ? context.expiresAt : row.expires_at) }));
        }
      }
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
            AND (principal LIKE 'artifact:%' OR (uploaded_at > ? AND NOT used)) LIMIT 1`,sha,now() - testHooks(this.env).holdSeconds).toArray().length).map(sha => `b/${sha}`),
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
   * An owner's or account's uploads of `shas` are used: an artifact points at
   * them now. They still let the uploader reuse the bytes, but no longer hold
   * them on their own; uploading them again does, for another day.
   */
  async consumeUploads(principal: string, shas: string[]): Promise<void> {
    if (principal.startsWith('artifact:') || principal.startsWith('attachment:')) return;
    for (const sha of shas) this.ctx.storage.sql.exec('UPDATE blob_uploads SET used = 1 WHERE sha = ? AND principal = ?',sha,principal);
  }
  /**
   * Forget `principal`'s (an owner's or account's) uploads that nothing used
   * within the hold, and delete the bytes nothing else holds: no artifact
   * points at them, no other upload of them is recorded, no attachment names them.
   */
  async sweepBlobUploads(principal: string): Promise<void> {
    if (principal.startsWith('artifact:') || principal.startsWith('attachment:')) return;
    const orphans = this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      const stale = sql.exec<{ sha: string }>('SELECT sha FROM blob_uploads WHERE principal = ? AND NOT used AND uploaded_at < ? LIMIT 1000',
        principal,now() - testHooks(this.env).holdSeconds).toArray().map(r => r.sha);
      for (const sha of stale) sql.exec('DELETE FROM blob_uploads WHERE sha = ? AND principal = ?',sha,principal);
      const held = (q: string, sha: string) => sql.exec(q,sha).toArray().length > 0;
      return this.tombstone(stale.filter(sha => !held('SELECT 1 FROM blob_refs WHERE sha = ? LIMIT 1',sha) &&
        !held('SELECT 1 FROM blob_uploads WHERE sha = ? LIMIT 1',sha) && !this.attachmentHeld(sha)).map(sha => `b/${sha}`));
    });
    await this.deleteObjects(orphans);
  }
  /**
   * The blobs among `shas` that artifact `id` may point at: ones it already
   * points at, or ones one of `principals` uploaded. Knowing a hash is not
   * enough to reach someone else's bytes.
   */
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
  async people(): Promise<(Account & { last_sign_in_at: number | null })[]> {
    // signed_in_at also holds legacy activation markers. Only audited sign-ins
    // are evidence for the admin display; aggregate once, not per account.
    return this.ctx.storage.sql.exec<Account & { last_sign_in_at: number | null }>(`
      SELECT a.*,s.last_sign_in_at FROM accounts a LEFT JOIN (
        SELECT actor_id,MAX(created_at) AS last_sign_in_at FROM activity
        WHERE action='sign_in' GROUP BY actor_id
      ) s ON s.actor_id=a.id ORDER BY a.email LIMIT 1000`).toArray();
  }
  /**
   * How many live artifacts each owner holds, count(*) in one pass: archived
   * ones count, expired ones do not, and a row with no owner_id (an artifact
   * from before accounts) counts as the instance owner's.
   */
  async artifactCounts(): Promise<Record<string, number>> {
    const rows = this.ctx.storage.sql.exec<{ ownerId: string; n: number }>(
      `SELECT COALESCE(owner_id,'instance-owner') AS ownerId, count(*) AS n FROM artifacts
       WHERE expires_at IS NULL OR expires_at > ? GROUP BY COALESCE(owner_id,'instance-owner')`,now()).toArray();
    return Object.fromEntries(rows.map(r => [r.ownerId,r.n]));
  }
  async invite(email: string, name: string): Promise<Account> {
    this.ctx.storage.sql.exec(`INSERT OR IGNORE INTO accounts (id,email,name,role,status,created_at) VALUES (?, ?, ?, 'member', 'invited', ?)`,genId(),email,name,now());
    return (await this.byEmail(email))!;
  }
  async status(id: string, status: string): Promise<void> {
    this.ctx.storage.transactionSync(() => {
      // Reactivating an account that never completed a sign-in puts it back under Invitations.
      if (status === 'active') this.ctx.storage.sql.exec(`UPDATE accounts SET status = CASE WHEN signed_in_at IS NULL THEN 'invited' ELSE 'active' END WHERE id = ? AND role != 'owner'`,id);
      else this.ctx.storage.sql.exec(`UPDATE accounts SET status = ? WHERE id = ? AND role != 'owner'`,status,id);
      if (status === 'disabled') {
        for (const t of ['sessions','credentials','logins']) this.ctx.storage.sql.exec(`DELETE FROM ${t} WHERE user_id = ?`,id);
      }
    });
  }
  /** Count one attempt against each of `keys`: false once any has had `limit` within its `window` seconds. */
  async rate(keys: (string | [string, number])[], limit = 5, window = 900): Promise<boolean> {
    return this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      sql.exec('DELETE FROM rate_limits WHERE expires <= ?',now());
      const pairs = keys.map(k => (typeof k === 'string' ? [k,limit] as [string, number] : k));
      const allowed = pairs.every(([key,max]) => (sql.exec<{ count: number }>('SELECT count FROM rate_limits WHERE key = ?',key).toArray()[0]?.count ?? 0) < max);
      if (allowed) for (const [key] of pairs) sql.exec('INSERT INTO rate_limits VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1',key,now()+window);
      return allowed;
    });
  }
  /** Seconds until `key` is under `limit` again; 0 when it is now. */
  async rateWait(key: string, limit = 5): Promise<number> {
    const row = this.ctx.storage.sql.exec<{ count: number; expires: number }>('SELECT count,expires FROM rate_limits WHERE key = ?',key).toArray()[0];
    return row && row.count >= limit && row.expires > now() ? row.expires - now() : 0;
  }
  /** When the pending sign-in link for `userId` expires, as a unix time, or null. */
  async loginExpiry(userId: string): Promise<number | null> {
    return this.ctx.storage.sql.exec<{ expires: number }>('SELECT max(expires) AS expires FROM logins WHERE user_id = ? AND expires > ?',userId,now()).toArray()[0]?.expires ?? null;
  }
  /** Remove an account that never signed in, with its pending links. False when it is not such an account. */
  async withdraw(id: string): Promise<boolean> {
    return this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      const gone = sql.exec<{ id: string }>(`DELETE FROM accounts WHERE id = ? AND role != 'owner' AND status = 'invited' AND signed_in_at IS NULL RETURNING id`,id).toArray().length > 0;
      if (gone) for (const t of ['logins','sessions','credentials']) sql.exec(`DELETE FROM ${t} WHERE user_id = ?`,id);
      return gone;
    });
  }
  async login(hash: string, userId: string): Promise<void> {
    this.ctx.storage.sql.exec('DELETE FROM logins WHERE expires <= ?',now());
    this.ctx.storage.sql.exec('INSERT INTO logins VALUES (?,?,?)',hash,userId,now()+LOGIN_TTL);
  }
  async verify(hash: string, sessionHash: string): Promise<Account | null> {
    return this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      const token = sql.exec<{ user_id: string }>('DELETE FROM logins WHERE hash = ? AND expires > ? RETURNING user_id',hash,now()).toArray()[0];
      if (!token) return null;
      const user = sql.exec<Account>(`SELECT * FROM accounts WHERE id = ? AND status IN ('active','invited')`,token.user_id).toArray()[0];
      if (!user) return null;
      sql.exec(`UPDATE accounts SET status = 'active', signed_in_at = ? WHERE id = ?`,now(),user.id);
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
  /**
   * The Repo's projection of a newer expiration intent. The revision is a CAS:
   * a repeat of a revision already applied is acknowledged without changing
   * anything or auditing again (the first reply may have been lost), and an
   * older revision is refused, so a delayed retry cannot undo a newer
   * deadline. The audit entry is written once, with the same acceptance.
   * Returns whether this call was accepted, refused as stale, or found no row
   * (the artifact may have been deleted, which a projection must never
   * reinsert).
   */
  async projectExpiration(input: { id: string; expiresAt: number | null; revision: number; actor: string; title: string | null }): Promise<'applied' | 'stale' | 'missing'> {
    // Test-only: make the projection fail so convergence through the Repo's
    // retry alarm can be observed. 'throw' fails every call; 'fail-once' fails
    // the first after the flag was set, then lets the retry through. Unset in
    // production; wrangler.jsonc declares it blank and deploy.sh blanks it again.
    const env = this.env as unknown as Record<string, string | undefined>;
    if (env.TEST_EXPIRATION_FAULT === 'throw') throw new Error('injected expiration projection failure');
    if (env.TEST_EXPIRATION_FAULT === 'fail-once' && !(await this.ctx.storage.get<boolean>('expiration-fault-used'))) {
      await this.ctx.storage.put('expiration-fault-used', true);
      throw new Error('injected expiration projection failure');
    }
    // Test-only: commit the first projection, then lose its reply, so the Repo
    // retries the same revision. Distinct from failing before the write.
    const dropAck = env.TEST_EXPIRATION_FAULT === 'drop-ack-once' && !(await this.ctx.storage.get<boolean>('expiration-ack-dropped'));
    if (dropAck) await this.ctx.storage.put('expiration-ack-dropped', true);
    const outcome = this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      const row = sql.exec<{ expiration_revision: number }>('SELECT expiration_revision FROM artifacts WHERE id=?',input.id).toArray()[0];
      if (!row) return 'missing';
      // Equal means an earlier attempt committed here but its reply was lost:
      // acknowledge it again without touching the row or auditing twice. Only
      // a strictly older revision is stale.
      if (input.revision < row.expiration_revision) return 'stale';
      if (input.revision === row.expiration_revision) return 'applied';
      sql.exec('UPDATE artifacts SET expires_at=?, expiration_revision=? WHERE id=?',input.expiresAt,input.revision,input.id);
      // Clearing an expiration also cancels any old deadline the library still
      // filters on; the row write above does that, and the audit says so once.
      // The structured deadline tells null (never expires) apart from an entry
      // written before metadata existed, whose date is unknown.
      if (input.actor) sql.exec('INSERT INTO activity (id,actor_id,action,artifact_id,artifact_title,created_at,target,details) VALUES (?,?,?,?,?,?,?,?)',
        genId(),input.actor,'expiration',input.id,input.title,now(),null,JSON.stringify({ expiresAt: isoOrNull(input.expiresAt) }));
      return 'applied';
    });
    if (dropAck) throw new Error('injected lost projection acknowledgement');
    return outcome;
  }
  async star(id: string, userId: string, starred: boolean): Promise<void> {
    this.ctx.storage.sql.exec(starred ? 'INSERT OR IGNORE INTO stars VALUES (?,?)' : 'DELETE FROM stars WHERE artifact_id=? AND user_id=?',id,userId);
  }
  async library(user: Account, opts: { admin: boolean; view: string; q: string; ownerId: string; status: string; cursor: string; limit: number; sort?: 'recent' | 'name' | 'expiry'; expiry?: 'all' | 'soon' }) {
    const clauses = [`${LIVE.replaceAll('expires_at','a.expires_at')}`];
    const args: (string | number)[] = [user.id,user.id,now()];
    if (!opts.admin) {
      clauses.push('a.archived=?'); args.push(opts.view === 'archived' ? 1 : 0);
      if (user.role !== 'owner') { clauses.push("(COALESCE(a.owner_id,'instance-owner')=? OR g.permission IS NOT NULL)"); args.push(user.id); }
      if (opts.view === 'mine') { clauses.push("COALESCE(a.owner_id,'instance-owner')=?"); args.push(user.id); }
      if (opts.view === 'shared') { clauses.push("COALESCE(a.owner_id,'instance-owner')!=? AND g.permission IS NOT NULL"); args.push(user.id); }
      if (opts.view === 'starred') clauses.push('s.user_id IS NOT NULL');
    } else {
      if (opts.ownerId) { clauses.push("COALESCE(a.owner_id,'instance-owner')=?"); args.push(opts.ownerId); }
    }
    if (opts.q) { clauses.push("instr(lower(a.title),lower(?)) > 0"); args.push(opts.q); }
    // Deadlines due within the next seven days, inclusive, among live rows
    // only: the LIVE clause already excludes anything past its deadline.
    if (opts.expiry === 'soon') { clauses.push('a.expires_at IS NOT NULL AND a.expires_at <= ?'); args.push(now() + 7 * 86400); }
    const joins = "FROM artifacts a LEFT JOIN accounts u ON u.id=COALESCE(a.owner_id,'instance-owner') LEFT JOIN grants g ON g.artifact_id=a.id AND g.user_id=? LEFT JOIN stars s ON s.artifact_id=a.id AND s.user_id=?";
    // The inventory's status tabs show how many are active and archived under the other filters.
    let counts: { all: number; active: number; archived: number } | undefined;
    if (opts.admin) {
      const archived = this.ctx.storage.sql.exec<{ n: number }>(`SELECT count(*) AS n ${joins} WHERE ${[...clauses,'a.archived=1'].join(' AND ')}`,...args).one().n;
      const active = this.ctx.storage.sql.exec<{ n: number }>(`SELECT count(*) AS n ${joins} WHERE ${[...clauses,'a.archived=0'].join(' AND ')}`,...args).one().n;
      counts = { all: active + archived, active, archived };
      if (opts.status !== 'all') { clauses.push('a.archived=?'); args.push(opts.status === 'archived' ? 1 : 0); }
    }
    const total = this.ctx.storage.sql.exec<{ n: number }>(`SELECT count(*) AS n ${joins} WHERE ${clauses.join(' AND ')}`,...args).one().n;
    // SQLite NOCASE folds ASCII only, not locale-specific Unicode ordering.
    // Keep the same collation and ID tie-breaker in the seek and ORDER BY.
    const byName = opts.sort === 'name';
    const byExpiry = opts.sort === 'expiry';
    if (opts.cursor) {
      const values = JSON.parse(opts.cursor);
      if (byName) {
        const [,title,id] = values;
        clauses.push('(a.title COLLATE NOCASE > ? OR (a.title COLLATE NOCASE = ? AND a.id > ?))'); args.push(title,title,id);
      } else if (byExpiry) {
        // Finite deadlines first, earliest to latest, then never-expiring rows,
        // each ordered by id. A null cursor value seeks within the null block.
        const [,deadline,id] = values;
        if (deadline === null) { clauses.push('(a.expires_at IS NULL AND a.id > ?)'); args.push(id); }
        else { clauses.push('(a.expires_at IS NULL OR a.expires_at > ? OR (a.expires_at = ? AND a.id > ?))'); args.push(deadline,deadline,id); }
      } else {
        const [time,id] = values;
        clauses.push('(a.updated_at < ? OR (a.updated_at=? AND a.id < ?))'); args.push(time,time,id);
      }
    }
    const rows = this.ctx.storage.sql.exec<Row & { ownerName: string; starred: number; permission: 'read' | 'write'; shared: number }>(`SELECT a.*,u.name AS ownerName,s.user_id IS NOT NULL AS starred, g.permission, EXISTS(SELECT 1 FROM grants x WHERE x.artifact_id=a.id) AS shared ${joins} WHERE ${clauses.join(' AND ')} ORDER BY ${byName ? 'a.title COLLATE NOCASE ASC,a.id ASC' : byExpiry ? '(a.expires_at IS NULL) ASC,a.expires_at ASC,a.id ASC' : 'a.updated_at DESC,a.id DESC'} LIMIT ?`,...args,opts.limit+1).toArray();
    const more = rows.length > opts.limit; rows.splice(opts.limit);
    const last = rows.at(-1);
    return { artifacts: rows.map(r => ({ ...toEntry(r), ownerName: r.ownerName ?? 'Instance owner', accessLabel: (r.owner_id ?? 'instance-owner') === user.id ? (r.shared ? 'Shared by you' : 'Private') : (user.role === 'owner' || r.permission === 'write' ? 'Can edit' : 'Can view'), starred: !!r.starred, permission: user.role === 'owner' || (r.owner_id ?? 'instance-owner') === user.id ? 'write' as const : r.permission, canManage: user.role === 'owner' || (r.owner_id ?? 'instance-owner') === user.id, visibility: r.shared ? 'shared' : 'private' })), total, ...(counts ? { counts } : {}), nextCursor: more && last ? JSON.stringify(byName ? ['name',last.title,last.id] : byExpiry ? ['expiry',last.expires_at,last.id] : [last.updated_at,last.id]) : null };
  }
  async audit(userId: string, action: string, id: string | null = null, title: string | null = null, target: string | null = null, details: Record<string, unknown> | null = null): Promise<void> {
    this.ctx.storage.sql.exec('INSERT INTO activity (id,actor_id,action,artifact_id,artifact_title,created_at,target,details) VALUES (?,?,?,?,?,?,?,?)',genId(),userId,action,id,title,now(),target,details ? JSON.stringify(details) : null);
  }
  /**
   * The newest audit events, optionally of one kind and matching a case-
   * insensitive search of the actor's name or email, the artifact title or id,
   * and the event's target. Search is applied before the limit and the cursor,
   * so a page is drawn from every matching event. Cursor is [createdAt, id].
   */
  async activity(limit: number, kind = '', cursor = '', q = '') {
    const clauses: string[] = []; const args: (string | number)[] = [];
    const actions = ACTIVITY_KINDS[kind];
    if (actions) { clauses.push(`e.action IN (${actions.map(() => '?').join(',')})`); args.push(...actions); }
    const search = q.slice(0, 300).trim();
    if (search) {
      // lower() folds ASCII only; the same fold is used on both sides. The
      // actor name matches the same synthesized "System" the select shows.
      const like = `%${search.replace(/[\\%_]/g, c => `\\${c}`)}%`;
      clauses.push(`(lower(COALESCE(a.name,CASE WHEN e.actor_id='system' THEN 'System' END)) LIKE ? ESCAPE '\\' OR lower(COALESCE(a.email,'')) LIKE ? ESCAPE '\\'
        OR lower(COALESCE(e.artifact_title,'')) LIKE ? ESCAPE '\\' OR lower(COALESCE(e.artifact_id,'')) LIKE ? ESCAPE '\\'
        OR lower(COALESCE(e.target,'')) LIKE ? ESCAPE '\\')`);
      args.push(like,like,like,like,like);
    }
    if (cursor) {
      try {
        const [time,id] = JSON.parse(cursor) as [number, string];
        if (Number.isFinite(time) && typeof id === 'string') { clauses.push('(e.created_at < ? OR (e.created_at = ? AND e.id < ?))'); args.push(time,time,id); }
      } catch { /* an unreadable cursor starts from the newest */ }
    }
    const rows = this.ctx.storage.sql.exec<{ id: string; actorName: string | null; action: string; artifactId: string | null; artifactTitle: string | null; target: string | null; createdAt: number; details: string | null }>(`SELECT e.id,COALESCE(a.name,CASE WHEN e.actor_id='system' THEN 'System' END) AS actorName,e.action,e.artifact_id AS artifactId,e.artifact_title AS artifactTitle,e.target,e.created_at AS createdAt,e.details FROM activity e LEFT JOIN accounts a ON a.id=e.actor_id${clauses.length ? ' WHERE ' + clauses.join(' AND ') : ''} ORDER BY e.created_at DESC,e.id DESC LIMIT ?`,...args,limit+1).toArray();
    const more = rows.length > limit; rows.splice(limit);
    const last = rows.at(-1);
    return { events: rows.map(r => {
      // details is structured metadata when this build wrote the event; an
      // event from before the column has none at all (not even null).
      const { details, ...event } = r;
      let parsed: unknown;
      try { parsed = details ? JSON.parse(details) : undefined; } catch { parsed = undefined; }
      return parsed !== undefined && parsed !== null && typeof parsed === 'object'
        ? { ...event, details: parsed as Record<string, unknown> } : event;
    }), nextCursor: more && last ? JSON.stringify([last.createdAt,last.id]) : null };
  }
}
/** The audit actions each Activity filter shows. */
export const ACTIVITY_KINDS: Record<string, string[]> = {
  artifacts: ['publish','delete','rotate-comment-link','expired','archive','restore','rename','transfer','sharing_change','expiration'],
  people: ['invite','invite_withdrawn','account_disabled','account_active'],
  credentials: ['credential_create','credential_revoke'],
  'sign-ins': ['sign_in'],
};
/**
 * Validate a requested expiration (`expiresAt` on the manage endpoint) against
 * the same ceiling creation uses. Returns the unix-seconds value, null for
 * "never expires", or an error message. Only an ISO 8601 UTC instant with a
 * `Z` suffix is accepted, so a date without a timezone cannot be read as the
 * server's local time.
 */
export function parseExpiration(value: unknown, maxTtl: number, secondsNow: number): { expiresAt: number | null } | { error: string } {
  if (value === null) return { expiresAt: null };
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?Z$/.test(value)) {
    return { error: 'expiresAt must be an ISO 8601 UTC date such as 2026-12-31T23:59:00Z, or null for no expiration' };
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return { error: 'expiresAt is not a valid date' };
  // Date.parse rolls impossible days forward (Feb 31 becomes Mar 2), so a date
  // is only accepted when every component survives the round trip.
  const d = new Date(ms);
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  const [hour, minute] = value.slice(11, 16).split(':').map(Number);
  const second = value.length > 19 ? Number(value.slice(17, 19)) : 0;
  if (d.getUTCFullYear() !== year || d.getUTCMonth() + 1 !== month || d.getUTCDate() !== day
    || d.getUTCHours() !== hour || d.getUTCMinutes() !== minute || d.getUTCSeconds() !== second) {
    return { error: 'expiresAt is not a real calendar date and time' };
  }
  const expiresAt = Math.floor(ms / 1000);
  if (expiresAt <= secondsNow) return { error: 'Expiration must be in the future' };
  if (!Number.isSafeInteger(maxTtl) || maxTtl <= 0) return { error: 'Expiration is not configured on this instance' };
  if (expiresAt > secondsNow + maxTtl) {
    return { error: `Expiration must be within ${Math.floor(maxTtl / 86400)} days` };
  }
  return { expiresAt };
}

function toEntry(r: Row): Entry { return { id:r.id,slug:r.slug,title:r.title,createdAt:r.created_at,updatedAt:r.updated_at,expiresAt:r.expires_at,tip:r.tip,ownerId:r.owner_id ?? 'instance-owner',archived:!!r.archived,icon:r.icon ?? 'document' }; }
