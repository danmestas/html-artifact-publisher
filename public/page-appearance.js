// Serialized into the opaque-origin artifact document. No credentials or DOM
// access cross the boundary: only the reader's light/dark/system preference.
export function pageAppearance(theme = 'system') {
  const authorTheme = document.documentElement.dataset.theme;
  const originals = new WeakMap();
  function apply() {
    if (theme === 'system' && authorTheme === undefined) delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme === 'system' ? authorTheme : theme;
    // Safari's blob iframe keeps OS media preferences instead of following its
    // embedding element's color-scheme. Override only color-scheme conditions;
    // retain width, orientation, print and all other media conditions verbatim.
    function visit(rules) {
      for (const rule of rules) {
        if (rule.media) {
          const original = originals.get(rule) ?? rule.media.mediaText;
          if (/\(\s*prefers-color-scheme\s*:/i.test(original)) {
            originals.set(rule, original);
            rule.media.mediaText = theme === 'system' ? original : original.replace(
              /\(\s*prefers-color-scheme\s*:\s*(light|dark)\s*\)/gi,
              (_, value) => value.toLowerCase() === theme ? '(min-width: 0px)' : '(max-width: 0px)',
            );
          }
        }
        if (rule.cssRules) visit(rule.cssRules);
      }
    }
    for (const sheet of document.styleSheets) {
      try { visit(sheet.cssRules); } catch { /* An inaccessible author stylesheet. */ }
    }
  }
  addEventListener('message', event => {
    const data = event.data;
    if (event.source !== parent || data?.__artifactAppearance !== 1 || !['light', 'dark', 'system'].includes(data.theme)) return;
    theme = data.theme;
    apply();
  });
  // The runtime is prepended before the author's styles have been parsed.
  document.addEventListener('DOMContentLoaded', () => {
    apply();
    // Theme styles may arrive after the initial document (for example, a page
    // adds a style element). CSSOM-only insertRule calls do not emit mutations.
    new MutationObserver(apply).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  });
}
