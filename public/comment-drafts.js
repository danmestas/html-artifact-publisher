// Private, same-tab recovery for the viewer, never the sandboxed artifact.
// Keys contain an identity scope, not an access credential. Account/guest
// changes select a different binding; nothing is restored across identities.
const PREFIX = 'hap-comment-draft:v1:';
const DAY = 24 * 60 * 60 * 1000;
const KINDS = new Set(['new', 'reply', 'edit']);

function keyFor(binding) {
  if (!binding || typeof binding !== 'object' || !KINDS.has(binding.kind)) return null;
  const parts = [binding.artifact, binding.version, binding.thread ?? '', binding.kind, binding.identity];
  if (!parts.every(value => typeof value === 'string' && value.length <= 256) || !parts[0] || !parts[1] || !parts[4]) return null;
  return PREFIX + JSON.stringify(parts);
}
function copy(draft) {
  return { ...draft, ...(draft.context ? { context: { ...draft.context } } : {}) };
}

export function createDraftStore(options = {}) {
  let storage = null;
  try { storage = Object.hasOwn(options, 'storage') ? options.storage : globalThis.sessionStorage; } catch { /* blocked browser storage */ }
  let persistent = !!storage;
  const memory = new Map();
  const now = options.now ?? Date.now;
  const maxAge = Math.min(DAY, Number.isFinite(options.maxAgeMs) && options.maxAgeMs > 0 ? options.maxAgeMs : DAY);
  function removeKey(key) {
    memory.delete(key);
    if (persistent) try { storage.removeItem(key); } catch { persistent = false; }
  }
  function loadKey(key) {
    let raw = memory.get(key) ?? null;
    if (persistent) try { raw = storage.getItem(key); } catch { persistent = false; }
    if (raw === null) return null;
    try {
      const record = JSON.parse(raw), draft = record.draft;
      if (record.schema !== 1 || record.key !== key || !draft || typeof draft.text !== 'string' || !draft.text.trim() || draft.text.length > 8000
          || typeof draft.anchor !== 'string' || draft.anchor.length > 500 || !Number.isFinite(draft.updatedAt)
          || draft.updatedAt > now() + 60_000 || now() - draft.updatedAt >= maxAge
          || (draft.context && (typeof draft.context.label !== 'string' || draft.context.label.length > 120 || typeof draft.context.quote !== 'string' || draft.context.quote.length > 240))) {
        removeKey(key); return null;
      }
      memory.set(key, raw);
      return copy(draft);
    } catch { removeKey(key); return null; }
  }
  function allKeys() {
    const keys = new Set(memory.keys());
    if (persistent) try {
      for (let i = 0; i < storage.length; i++) { const key = storage.key(i); if (key?.startsWith(PREFIX)) keys.add(key); }
    } catch { persistent = false; }
    return keys;
  }
  return {
    get persistent() { return persistent; },
    save(binding, value) {
      const key = keyFor(binding);
      if (!key || !value || typeof value.text !== 'string' || value.text.length > 8000) return false;
      if (!value.text.trim()) { removeKey(key); return true; }
      const draft = { text: value.text, anchor: typeof value.anchor === 'string' ? value.anchor.slice(0, 500) : '', updatedAt: now() };
      if (value.context && typeof value.context.label === 'string' && typeof value.context.quote === 'string') {
        draft.context = { label: value.context.label.slice(0, 120), quote: value.context.quote.slice(0, 240) };
      }
      const raw = JSON.stringify({ schema: 1, key, draft });
      memory.set(key, raw);
      if (persistent) try { storage.setItem(key, raw); } catch { persistent = false; }
      return true;
    },
    load(binding) {
      const key = keyFor(binding);
      return key ? loadKey(key) : null;
    },
    list(scope) {
      if (!keyFor({ ...scope, kind: 'new', thread: '' })) return [];
      const entries = [];
      for (const key of allKeys()) try {
        const [artifact, version, thread, kind, identity] = JSON.parse(key.slice(PREFIX.length));
        if (artifact !== scope.artifact || version !== scope.version || identity !== scope.identity) continue;
        const binding = { artifact, version, thread, kind, identity };
        if (keyFor(binding) !== key) continue;
        const draft = loadKey(key);
        if (draft) entries.push({ binding, draft });
      } catch { /* malformed namespaced data is never a draft */ }
      return entries;
    },
    remove(binding) {
      const key = keyFor(binding);
      if (key) removeKey(key);
    },
    clearAll() {
      for (const key of allKeys()) removeKey(key);
    },
    clearIdentity(identity) {
      if (typeof identity !== 'string' || !identity) return;
      for (const key of allKeys()) try { if (JSON.parse(key.slice(PREFIX.length))[4] === identity) removeKey(key); } catch { /* not a valid draft key */ }
    },
  };
}
