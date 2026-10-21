// Per-browser appearance only; never stores identity or credentials.
(() => {
  const key = 'artifact-library-preferences';
  const read = () => { try { return JSON.parse(localStorage.getItem(key) || '{}') || {}; } catch { return {}; } };
  function apply(value) {
    const theme = !document.documentElement.hasAttribute('data-system-appearance') && ['light', 'dark'].includes(value) ? value : 'system';
    if (theme === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    document.querySelectorAll('[data-appearance]').forEach(control => { control.value = theme; });
  }
  apply(read().theme);
  document.addEventListener('DOMContentLoaded', () => {
    apply(read().theme);
    document.querySelectorAll('[data-appearance]').forEach(control => control.addEventListener('change', () => {
      if (document.documentElement.hasAttribute('data-system-appearance')) return;
      apply(control.value);
      try { localStorage.setItem(key, JSON.stringify({ ...read(), theme: control.value })); } catch { /* Optional preference. */ }
    }));
  });
  new MutationObserver(() => apply(read().theme)).observe(document.documentElement, {
    attributes: true, attributeFilter: ['data-system-appearance'],
  });
  window.addEventListener('storage', e => { if (e.key === key) apply(read().theme); });
})();
