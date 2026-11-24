// Shared by browser and Worker: a sign-in return is navigation, never access.
const LIBRARY_KEYS = new Set(['view', 'q', 'sort', 'ownerId', 'status', 'expiry', 'kind', 'n', 'page', 'pageSize', 'layout']);

/**
 * A discussion reference from `?thread=`: a ticket uuid, 40 or 64 lowercase
 * hex digits. Anything else is not a discussion, so the query is dropped
 * rather than echoed back into a login URL or email.
 */
export function threadRef(value) {
  return typeof value === 'string' && /^[a-f0-9]{40}$|^[a-f0-9]{64}$/.test(value) ? value : '';
}

export function safeReturnTo(value) {
  if (typeof value !== 'string' || value.length > 4096 || !value.startsWith('/')
      || value.startsWith('//') || /[\\\u0000- \u007f]/.test(value)) return '/';
  try {
    const url = new URL(value, 'https://artifact.invalid');
    if (url.origin !== 'https://artifact.invalid') return '/';
    if (/^\/v\/[A-Za-z0-9_-]{1,64}$/.test(url.pathname)) {
      // Read/edit/comment capabilities never enter login URLs or email. A
      // discussion reference is navigation within the artifact, not access:
      // it survives so the sign-in round trip can reopen the same thread.
      const version = /^#@[a-f0-9]{6,64}$/.test(url.hash) ? url.hash : '';
      const thread = threadRef(url.searchParams.get('thread'));
      return url.pathname + (thread ? `?thread=${thread}` : '') + version;
    }
    if (url.pathname !== '/') return '/';
    const query = new URLSearchParams();
    for (const [key, entry] of url.searchParams) {
      if (LIBRARY_KEYS.has(key) && entry.length <= 300) query.set(key, entry);
    }
    return '/' + (query.size ? '?' + query.toString() : '');
  } catch { return '/'; }
}

export function signinUrl(destination) {
  const target = safeReturnTo(destination);
  return target === '/' ? '/login' : '/login?returnTo=' + encodeURIComponent(target);
}
