// backdrop.js — the colour behind the artifact page.
//
// The page renders in an iframe whose own background shows wherever the page's
// canvas does not reach: a document that paints no background, and, on iOS, the
// strip a rubber-band scroll reveals beyond the content. A fixed white there
// flash-bangs a dark page. Instead, the injected page runtime measures the
// page's canvas — the same html-then-body propagation the browser uses — and
// the viewer paints the frame with it. A page that paints none stays
// transparent, and its canvas follows the viewer's Light, Dark or System choice.

/**
 * The colour to paint behind the frame, or null when the page named none.
 * Only a computed colour function is accepted; a page cannot inject markup,
 * a URL or a declaration through this value. Injected into pages as source, so
 * it carries its pattern rather than closing over this module.
 */
export function backdropColor(value) {
  return typeof value === 'string' && /^(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([0-9a-z.,%/\s+-]{1,120}\)$/i.test(value) ? value : null;
}

/**
 * The page's canvas colour, or null when the page has no opaque canvas.
 *
 * Only an opaque canvas can be mirrored behind the page. A translucent colour
 * lets whatever is behind the page show through, so painting it behind as well
 * would composite the same layer twice and change how the page looks. A page
 * with a translucent canvas keeps the viewer's ground behind it.
 *
 * Propagation matches the browser's: the root's background is the canvas, and
 * the body's is propagated only when the root sets no background at all. A
 * translucent root still stops there — the body's background then covers the
 * body box only, not the canvas. Each layer is `{ color, paints, opaque }`.
 * Injected into pages as source, so it takes its `backdropColor` validator as
 * an argument rather than closing over this module.
 */
export function chooseCanvas(html, body, backdropColor) {
  if (!html?.paints) return backdropColor(body?.opaque ? body.color : null);
  return html.opaque ? backdropColor(html.color) : null;
}

/**
 * Injected into every page (as source, like page-pins.js). Reports the page's
 * canvas to the viewer on load, when its colours change, and when the viewer's
 * appearance changes the scheme the page follows, so a page that switches
 * theme at runtime keeps its backdrop.
 */
export function pageBackdrop(chooseCanvas, backdropColor) {
  let last = null;
  function report() {
    try {
      const html = getComputedStyle(document.documentElement);
      const body = document.body ? getComputedStyle(document.body) : null;
      // A 1x1 canvas resolves a colour's alpha for every syntax without
      // parsing colour spaces by hand. `paints` means any alpha; `opaque` means
      // full alpha, the only canvas safe to mirror behind the page.
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const ctx = canvas.getContext('2d');
      function alpha(color) {
        if (!color) return 0;
        if (!ctx) return /^(?:transparent|rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\))$/i.test(color) ? 0 : 255;
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillStyle = color; // an invalid value leaves the canvas clear
        ctx.fillRect(0, 0, 1, 1);
        return ctx.getImageData(0, 0, 1, 1).data[3];
      }
      const layer = color => {
        const a = alpha(color);
        return { color, paints: a > 0, opaque: a === 255 };
      };
      const color = chooseCanvas(
        layer(html.backgroundColor),
        body && layer(body.backgroundColor),
        backdropColor,
      );
      if (color === last) return;
      last = color;
      parent.postMessage({ __artifactBackdrop: 1, color }, '*');
    } catch { /* presentation only: never break the page */ }
  }
  const later = () => setTimeout(report, 0);
  // Theme stylesheets may add or change a root class, a data-theme attribute or
  // an inline style; any of them can change the canvas.
  const watch = target => {
    try {
      new MutationObserver(later).observe(target, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
    } catch { /* an unusual document; the load report still runs */ }
  };
  watch(document.documentElement);
  addEventListener('DOMContentLoaded', () => { later(); if (document.body) watch(document.body); });
  addEventListener('load', later);
  // The viewer's Light / Dark / System choice changes the scheme the page sees,
  // so a theme-following page's colours change without any attribute change.
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', later);
  later();
}
