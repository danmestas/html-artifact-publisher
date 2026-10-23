import { DurableObject } from 'cloudflare:workers';
import { genId } from './util';

export interface Entry {
  id: string; slug: string | null; title: string; createdAt: number; updatedAt: number;
  expiresAt: number | null; tip: string; ownerId?: string; archived?: boolean;
}
export type Account = { id: string; email: string; name: string; role: 'owner' | 'member'; status: 'active' | 'invited' | 'disabled' };
type Row = { id: string; slug: string | null; title: string; created_at: number; updated_at: number; expires_at: number | null; tip: string; owner_id: string | null; archived: number };
const now = () => Math.floor(Date.now() / 1000);
const LIVE = '(expires_at IS NULL OR expires_at > ?)';

export class Registry extends DurableObject<Env> {
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
      CREATE TABLE IF NOT EXISTS blob_uploads (sha TEXT NOT NULL, principal TEXT NOT NULL, PRIMARY KEY(sha,principal));`);
    const cols = sql.exec<{ name: string }>('PRAGMA table_info(artifacts)').toArray();
    if (!cols.some(c => c.name === 'owner_id')) sql.exec('ALTER TABLE artifacts ADD COLUMN owner_id TEXT');
    if (!cols.some(c => c.name === 'archived')) sql.exec('ALTER TABLE artifacts ADD COLUMN archived INTEGER NOT NULL DEFAULT 0');
    sql.exec(`CREATE INDEX IF NOT EXISTS artifacts_name_order ON artifacts(title COLLATE NOCASE,id);
      CREATE INDEX IF NOT EXISTS artifacts_library_order ON artifacts(updated_at DESC,id DESC);
      CREATE INDEX IF NOT EXISTS artifacts_owner ON artifacts(owner_id,archived,updated_at DESC,id DESC);
      CREATE INDEX IF NOT EXISTS grants_user ON grants(user_id,artifact_id);
      CREATE INDEX IF NOT EXISTS stars_user ON stars(user_id,artifact_id);
      CREATE INDEX IF NOT EXISTS activity_order ON activity(created_at DESC,id DESC);`);
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
    sql.exec('INSERT INTO artifacts (id,slug,title,created_at,updated_at,expires_at,tip,owner_id) VALUES (?,?,?,?,?,?,?,?)', e.id,e.slug,e.title,e.createdAt,e.updatedAt,e.expiresAt,e.tip,e.ownerId ?? 'instance-owner');
    return true;
  }
  async resolve(key: string): Promise<string | null> {
    return this.ctx.storage.sql.exec<{ id: string }>(`SELECT id FROM artifacts WHERE (id = ? OR slug = ?) AND ${LIVE} LIMIT 1`,key,key,now()).toArray()[0]?.id ?? null;
  }
  async get(id: string): Promise<Entry | null> {
    const r = this.ctx.storage.sql.exec<Row>('SELECT * FROM artifacts WHERE id = ?', id).toArray()[0];
    return r ? toEntry(r) : null;
  }
  async touch(id: string, tip: string, title?: string): Promise<void> {
    this.ctx.storage.sql.exec('UPDATE artifacts SET tip = ?, updated_at = ?, title = COALESCE(?,title) WHERE id = ?',tip,now(),title ?? null,id);
  }
  /** Delete an artifact's listing, and the R2 blobs no other artifact points at. */
  async remove(id: string): Promise<void> {
    const orphans = this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      for (const table of ['grants','stars']) sql.exec(`DELETE FROM ${table} WHERE artifact_id = ?`,id);
      sql.exec('DELETE FROM artifacts WHERE id = ?',id);
      const shas = sql.exec<{ sha: string }>('SELECT sha FROM blob_refs WHERE artifact_id = ?',id).toArray().map(r => r.sha);
      sql.exec('DELETE FROM blob_refs WHERE artifact_id = ?',id);
      sql.exec('DELETE FROM blob_uploads WHERE principal = ?',`artifact:${id}`);
      return shas.filter(sha => !sql.exec('SELECT 1 FROM blob_refs WHERE sha = ? LIMIT 1',sha).toArray().length);
    });
    for (let i = 0; i < orphans.length; i += 1000) await this.env.BLOBS.delete(orphans.slice(i, i + 1000).map(sha => `b/${sha}`));
  }
  /** Record that artifact `id` points at these blobs (idempotent). */
  async refBlobs(id: string, shas: string[]): Promise<void> {
    for (const sha of new Set(shas)) this.ctx.storage.sql.exec('INSERT OR IGNORE INTO blob_refs VALUES (?,?)',sha,id);
  }
  /** `principal` (artifact:<id>, user:<id> or owner) sent these exact bytes. */
  async recordUpload(sha: string, principal: string): Promise<void> {
    this.ctx.storage.sql.exec('INSERT OR IGNORE INTO blob_uploads VALUES (?,?)',sha,principal);
  }
  /**
   * The blobs among `shas` that artifact `id` may point at: ones it already
   * points at, or ones one of `principals` uploaded. Knowing a hash is not
   * enough to reach someone else's bytes.
   */
  async allowedBlobs(id: string, principals: string[], shas: string[]): Promise<string[]> {
    const sql = this.ctx.storage.sql;
    return [...new Set(shas)].filter(sha =>
      sql.exec('SELECT 1 FROM blob_refs WHERE sha = ? AND artifact_id = ?',sha,id).toArray().length ||
      principals.some(p => sql.exec('SELECT 1 FROM blob_uploads WHERE sha = ? AND principal = ?',sha,p).toArray().length));
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
  async rate(keys: string[]): Promise<boolean> {
    return this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      sql.exec('DELETE FROM rate_limits WHERE expires <= ?',now());
      const allowed = keys.every(key => (sql.exec<{ count: number }>('SELECT count FROM rate_limits WHERE key = ?',key).toArray()[0]?.count ?? 0) < 5);
      if (allowed) for (const key of keys) sql.exec('INSERT INTO rate_limits VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1',key,now()+900);
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
function toEntry(r: Row): Entry { return { id:r.id,slug:r.slug,title:r.title,createdAt:r.created_at,updatedAt:r.updated_at,expiresAt:r.expires_at,tip:r.tip,ownerId:r.owner_id ?? 'instance-owner',archived:!!r.archived }; }
