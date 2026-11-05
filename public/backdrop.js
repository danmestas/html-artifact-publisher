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
 * The page's canvas: the html layer, then the body — the propagation browsers
 * use — and the first that paints. Each layer is `{ color, paints }`, where
 * `paints` measures its alpha; a page with neither is transparent. Injected
 * into pages as source, so it takes its `backdropColor` validator as an
 * argument rather than closing over this module.
 */
export function chooseCanvas(html, body, backdropColor) {
  const layer = [html, body].find(candidate => candidate?.paints && backdropColor(candidate.color));
  return backdropColor(layer?.color);
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
      // Alpha decides whether a layer paints. A 1x1 canvas resolves it for every
      // colour syntax without parsing colour spaces by hand.
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const ctx = canvas.getContext('2d');
      function paints(color) {
        if (!color) return false;
        if (!ctx) return !/^(?:transparent|rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\))$/i.test(color);
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillStyle = color; // an invalid value leaves the canvas clear
        ctx.fillRect(0, 0, 1, 1);
        return ctx.getImageData(0, 0, 1, 1).data[3] > 0;
      }
      const color = chooseCanvas(
        { color: html.backgroundColor, paints: paints(html.backgroundColor) },
        body && { color: body.backgroundColor, paints: paints(body.backgroundColor) },
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
