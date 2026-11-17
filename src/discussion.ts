/** Strict public discussion inputs. Identity IDs are never accepted from the wire. */
export type DiscussionIdentity = 'guest' | 'account';
export interface DiscussionContext { label: string; quote: string }
export interface DiscussionQuery {
  limit: number;
  cursor: string;
  q: string;
  filter: 'all' | 'open' | 'resolved' | 'mine' | 'unread' | 'following';
  sort: 'activity' | 'reference';
  identity?: DiscussionIdentity;
  thread?: string;
}

/** Missing means legacy behavior; a supplied value is only an equality precondition, never authentication. */
export function commentIdentityPrecondition(value: string | null): string | undefined | null {
  if (value === null) return undefined;
  return /^(?:account|guest):[A-Za-z0-9_-]{1,128}$/.test(value) ? value : null;
}

export function discussionQuery(params: URLSearchParams): DiscussionQuery | null {
  const limit = params.get('limit') ?? '100';
  const rawQuery = params.get('q') ?? '';
  const q = rawQuery.trim();
  const cursor = params.get('cursor') ?? '';
  const filter = params.get('filter') ?? 'all';
  const sort = params.get('sort') ?? 'activity';
  const identity = params.get('identity') ?? undefined;
  if (!/^[1-9][0-9]{0,2}$/.test(limit) || Number(limit) > 200 || rawQuery.length > 240 || cursor.length > 2048
    || /\0/.test(q) || !['all', 'open', 'resolved', 'mine', 'unread', 'following'].includes(filter)
    || !['activity', 'reference'].includes(sort) || (identity !== undefined && identity !== 'guest' && identity !== 'account')) return null;
  const thread = params.get('thread');
  if (thread !== null && (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(thread)
    || ['q', 'filter', 'sort', 'cursor'].some(k => params.has(k)) || (params.has('limit') && limit !== '1'))) return null;
  return { limit: thread ? 1 : Number(limit), q, cursor, filter: filter as DiscussionQuery['filter'], sort: sort as DiscussionQuery['sort'], identity, ...(thread ? { thread } : {}) };
}
export function correctionInput(value: unknown): { text: string; identity?: DiscussionIdentity } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(k => k !== 'text' && k !== 'identity') || typeof v.text !== 'string'
    || !v.text.trim() || v.text.trim().length > 8000 || /\0/.test(v.text)
    || (v.identity !== undefined && v.identity !== 'guest' && v.identity !== 'account')) return null;
  return { text: v.text.trim(), ...(v.identity ? { identity: v.identity as DiscussionIdentity } : {}) };
}
export function viewInput(value: unknown): { readThrough?: string; following?: boolean; identity?: DiscussionIdentity } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(k => !['readThrough', 'following', 'identity'].includes(k))
    || (v.readThrough !== undefined && (typeof v.readThrough !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(v.readThrough)))
    || (v.following !== undefined && typeof v.following !== 'boolean')
    || (v.identity !== undefined && v.identity !== 'guest' && v.identity !== 'account')) return null;
  return v as { readThrough?: string; following?: boolean; identity?: DiscussionIdentity };
}
export function contextInput(value: unknown): DiscussionContext | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(k => k !== 'label' && k !== 'quote')) return null;
  const { label = '', quote = '' } = v;
  if (typeof label !== 'string' || typeof quote !== 'string' || label.length > 120 || quote.length > 240 || /\0/.test(label + quote)) return null;
  return { label: label.trim(), quote: quote.trim() };
}
