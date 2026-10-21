// Per-browser appearance only; never stores identity or credentials.
(() => {
  const key = 'artifact-library-preferences';
  const read = () => { try { return JSON.parse(localStorage.getItem(key) || '{}') || {}; } catch { return {}; } };
  function apply(value) {
    const theme = ['light', 'dark'].includes(value) ? value : 'system';
    if (theme === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    document.querySelectorAll('[data-appearance]').forEach(control => { control.value = theme; });
  }
  apply(read().theme);
  document.addEventListener('DOMContentLoaded', () => {
    apply(read().theme);
    document.querySelectorAll('[data-appearance]').forEach(control => control.addEventListener('change', () => {
      apply(control.value);
      try { localStorage.setItem(key, JSON.stringify({ ...read(), theme: control.value })); } catch { /* Optional preference. */ }
    }));
  });
  window.addEventListener('storage', e => { if (e.key === key) apply(read().theme); });
})();
