---
name: artifact-diagrams
description: Load before putting a diagram - architecture, data flow, sequence, state machine, before/after comparison, timeline or any box-and-arrow figure - into an HTML page that will be published as an artifact through this repo's viewer. Covers when a diagram is worth drawing, how to show the real mechanism, layout/labels/arrows, and theme-aware inline SVG that works under the viewer's CSP and at phone width (no Mermaid or other CDN renderers). Use with artifact-design (page design) and publish-html-page (publishing); for charts of numbers load artifact-dataviz instead.
---

# Diagrams for artifacts

A diagram belongs in a page when the reader would otherwise have to build a picture in their
head from several paragraphs: which component calls which, where data crosses a boundary,
what a request passes through, which states a job can be in, what is different between two
designs. If one sentence carries the point ("the worker retries three times, then gives
up"), write the sentence and skip the figure.

Pages are published as Fossil-versioned artifacts and rendered by our viewer in a sandboxed
iframe with a strict CSP (see **publish-html-page** for the publishing side and
**artifact-design** for overall page design). For diagrams that means:

- **No Mermaid, PlantUML, D3 or Graphviz from a CDN.** The page has no network access; a
  `<script src="https://...">` never runs. Draw the diagram as **inline SVG written by
  hand** (or produced by a short inline script). Most diagrams in a page are 5-15 shapes,
  which is less work by hand than fighting a layout engine.
- **No inline event handlers.** `onclick=` / `onmouseover=` are blocked. If parts of the
  diagram are interactive (highlight a path, toggle "before / after"), attach listeners with
  `addEventListener` in an inline `<script>`.
- **Theme follows the OS.** Colours come from CSS custom properties with a
  `prefers-color-scheme: dark` override; the SVG inherits them.
- **Phone to desktop.** The viewer gives the page the full width under its top bar - as little
  as ~360 px on a phone.
- **No image export.** There is no "download diagram" path (downloads are blocked). The SVG is
  the deliverable; people who need it elsewhere can copy the page's source.

## Deciding what to draw

**Show how it works, not what it is called.** Five boxes named after services, joined by
unlabeled lines, is an org chart of the code. The useful version shows the path a request
or record actually takes: what it enters, where it waits, where it gets copied, which hop
fails. Draw the pieces the argument depends on and leave the rest out, even if they exist.

**For a choice, draw the difference.** If the page compares option A and option B, draw both
with the same layout and the same positions for shared parts, so the eye lands on what
changed: the queue that appears, the arrow that reverses, the store that moves across the
trust boundary. Mark the changed element (accent colour or a heavier stroke) and say in the
caption what changed. Two unrelated boxes labeled "A" and "B" compare nothing.

**Size the drawing to the question.** A "does the browser talk to the database directly?"
question needs three boxes. A migration that moves writes onto a queue with an ordering
guarantee needs the producer, the queue, the consumer, the old write path (dimmed) and the
ordering note. Do not shrink a real mechanism into a slogan, and do not draw the whole system
because you can.

**Pick the diagram type from the question:**

| Question | Diagram |
|---|---|
| What talks to what, through which boundary? | box-and-arrow with boundary regions |
| In what order do things happen between parties? | sequence (lifelines left→right, time downward) |
| What states can this thing be in, and what moves it? | state machine (states as rounded boxes, events on arrows) |
| What changes between now and the proposal? | two aligned panels, or one panel with added/removed parts styled |
| When does each step happen? | timeline on one horizontal axis |
| How is this nested / owned? | nested regions, not a tree of boxes, when containment is the point |

## Layout

- **One reading direction.** Flows go left→right; layers (client / server / storage) stack
  top→bottom. Do not mix the two in one figure.
- **Use a grid.** Pick a column pitch and row pitch (e.g. boxes 120×44 on a 180 px column
  pitch) and place everything on it. Equal gaps and shared centre lines are what make a hand
  diagram look intentional.
- **Arrows are straight or orthogonal.** Horizontal and vertical segments; one bend at most
  where possible. Avoid crossings - move a box before you add a crossing.
- **Boundaries are regions.** A dashed rounded rect behind the boxes, labeled in its corner
  ("browser sandbox", "server", "Fossil repo"), shows a trust or process boundary better than
  a note.
- **Leave margin.** 12-16 px inside the viewBox edge so strokes and labels are never clipped.

## Labels and arrows

- **Every arrow says what it carries** unless the meaning is obvious and identical everywhere:
  `POST /api/publish`, `check-in`, `polls 60 s`, `reads (token)`. Put the label just above the
  midpoint of a horizontal arrow, or beside a vertical one.
- **Box labels are names, 1-3 words.** Detail goes in a second, smaller line or in the caption.
  Sentences inside a diagram are a sign the text belongs in the prose.
- **Text size 12-14 px at the drawn scale,** never below ~10 px after the figure is scaled to
  phone width (see below). Use `text-anchor="middle"` and `dominant-baseline="middle"` to
  centre labels in boxes instead of guessing offsets.
- **Arrowheads** come from one `<marker>` in `<defs>`, referenced by `marker-end`. Give the
  marker `fill="context-stroke"` where supported, or simply `fill: currentColor`, so its colour
  matches the line in both themes.
- **Encodings are few and explained.** Solid = synchronous call, dashed = async / eventual is
  fine, but if you use it, add a two-item key under the figure. If an encoding appears once,
  label the mark instead of adding a legend.
- **One accent colour** for the element the text is about; everything else in ink and muted
  ink. Colour that does not mean anything is noise.

## Theme-aware inline SVG

Define tokens on the page (artifact-design has the full set) and draw with them:

- strokes and text: `currentColor` (the SVG's `color` is set to `var(--ink)`);
- box fills: `var(--panel)`, a slightly raised surface; boundary regions: no fill, dashed
  `var(--ink-2)` stroke;
- accent: `var(--accent)`, chosen to reach at least 3:1 on both the light and dark surface
  (check it with `node skills/artifact-dataviz/check-contrast.mjs --bg <surface> --colors <accent>`).

Set these through a `<style>` block in the page (CSS classes on the SVG elements), not via
`fill="var(--x)"` attributes, which are not reliably resolved as presentation attributes.
Never hard-code `#000` / `#fff` in a diagram - it disappears in one of the two themes.

Keep the SVG self-contained: ids referenced only inside the same document (`url(#arrow)`),
no `<image href="https://...">`, no `<foreignObject>`. If the page has two diagrams, give each
marker a unique id (`arrow-a`, `arrow-b`) - duplicate ids make the second figure's arrows
silently pick up the first's marker.

## Example: box-and-arrow with a marker arrowhead

```html
<figure class="diagram">
  <div class="scroll">
    <svg viewBox="0 0 640 200" role="img"
         aria-label="The CLI posts the page to the server, which commits it to a Fossil repository; the viewer later reads the check-in and renders it in a sandboxed iframe.">
      <defs>
        <marker id="arrow-pub" viewBox="0 0 10 10" refX="9" refY="5"
                markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" class="head" />
        </marker>
      </defs>

      <rect class="region" x="196" y="16" width="428" height="96" rx="10" />
      <text class="region-label" x="208" y="34">server</text>

      <g class="node"><rect x="16" y="48" width="132" height="44" rx="8" />
        <text x="82" y="70">publish CLI</text></g>
      <g class="node"><rect x="220" y="48" width="132" height="44" rx="8" />
        <text x="286" y="70">API</text></g>
      <g class="node accent"><rect x="472" y="48" width="132" height="44" rx="8" />
        <text x="538" y="70">Fossil repo</text></g>
      <g class="node"><rect x="472" y="140" width="132" height="44" rx="8" />
        <text x="538" y="162">viewer iframe</text></g>

      <line class="edge" x1="148" y1="70" x2="218" y2="70" marker-end="url(#arrow-pub)" />
      <text class="edge-label" x="183" y="62">POST</text>
      <line class="edge" x1="352" y1="70" x2="470" y2="70" marker-end="url(#arrow-pub)" />
      <text class="edge-label" x="411" y="62">check-in</text>
      <line class="edge" x1="538" y1="92" x2="538" y2="138" marker-end="url(#arrow-pub)" />
      <text class="edge-label" x="546" y="120" text-anchor="start">reads files</text>
    </svg>
  </div>
  <figcaption>Each publish becomes a Fossil check-in; the viewer renders whichever check-in
    the link names.</figcaption>
</figure>

<style>
  .diagram { margin: 24px 0; }
  .diagram .scroll { overflow-x: auto; }
  .diagram svg { display: block; width: 100%; min-width: 480px; height: auto;
                 color: var(--ink); font: 13px/1 system-ui, sans-serif; }
  .diagram .node rect { fill: var(--panel); stroke: currentColor; stroke-width: 1.5; }
  .diagram .node.accent rect { stroke: var(--accent); stroke-width: 2.5; }
  .diagram .node text { fill: currentColor; text-anchor: middle; dominant-baseline: middle; }
  .diagram .region { fill: none; stroke: var(--ink-2); stroke-dasharray: 5 4; }
  .diagram .region-label { fill: var(--ink-2); font-size: 12px; }
  .diagram .edge { stroke: currentColor; stroke-width: 1.5; }
  .diagram .head { fill: currentColor; }
  .diagram .edge-label { fill: var(--ink-2); font-size: 12px; text-anchor: middle; }
  .diagram figcaption { color: var(--ink-2); font-size: 14px; margin-top: 8px; }
</style>
```

With page tokens such as:

```css
:root { --ink: #1d1f23; --ink-2: #555a63; --panel: #f3f4f6; --accent: #2563c9; --surface: #ffffff; }
@media (prefers-color-scheme: dark) {
  :root { --ink: #e9eaec; --ink-2: #a7acb5; --panel: #22252a; --accent: #5b9bf0; --surface: #15171a; }
}
body { background: var(--surface); color: var(--ink); }
```

Why it holds up: every colour is a token, so the OS theme repaints it; the arrowhead is a
marker filled with `currentColor`, so it always matches its line; the line ends 2 px before
the target box so the head is not buried in the box stroke; `min-width: 480px` inside an
`overflow-x: auto` wrapper keeps labels at a readable size on a phone, where the figure
scrolls inside its box instead of shrinking text to 7 px or pushing the page sideways.

## Phone width

- `viewBox` + `width: 100%; height: auto` is the baseline. Compute the scale: a 640-wide
  viewBox on a 340 px content column shrinks 13 px text to ~7 px - too small.
- Choose per figure: (a) a `min-width` plus a horizontal scroll container (as above) for wide
  flows; (b) a second, vertical layout of the same diagram for narrow screens, swapped by a
  CSS media query (`.wide { display: none }` under `max-width: 520px`, and the reverse); or
  (c) design top→bottom from the start when the flow allows it - tall diagrams scroll
  naturally on phones.
- Do not rely on hover to reveal labels; touch has no hover.

## Interactivity (optional)

Most diagrams should be static. When interaction answers a real question - "show only the
write path", "compare before and after" - use real `<button>`s above the figure and toggle
classes on SVG groups with `addEventListener('click', ...)`. Keep both states drawable on the
same grid so toggling moves nothing that did not change. Respect `prefers-reduced-motion`
(no animated transitions when it is set). Do not store the toggle state in `localStorage` -
it throws in the sandbox; if it must persist, use `window.artifact.data`, and remember that
writes need the edit link.

## When hand-drawing stops being reasonable

If the figure needs automatic layout of dozens of nodes (a dependency graph of a whole repo),
draw a smaller diagram of the part the argument needs - that is usually the better figure
anyway. If you truly need a layout engine, vendor it as a file in the published directory
(the viewer inlines `<script src="relative.js">`), keeping it under ~1.99 MB compressed, as a
classic script, and checking that it does not use `eval` / `new Function` / WebAssembly.
Mermaid's and similar text-to-diagram renderers are large, often load extras on demand and may
evaluate code at runtime; test through the real viewer, and prefer pre-rendering to static
SVG offline and pasting the SVG in (then replace hard-coded colours with tokens).

## Accessibility

- Wrap each diagram in `<figure>` with a `<figcaption>` stating what it shows.
- Give the `<svg>` `role="img"` and an `aria-label` that tells the same story in one or two
  sentences - the path, not a list of box names.
- Text and lines reach 4.5:1 / 3:1 against the surface in both themes; the accent is never
  the only carrier of meaning (pair it with a heavier stroke, a label, or the caption).
- For complex flows, the prose next to the figure should also state the steps in order.

## Before publishing

- [ ] The diagram shows a mechanism or a difference the text depends on; a sentence wouldn't do.
- [ ] Every arrow is labeled or its meaning is stated once in a key.
- [ ] Shapes sit on a grid; no crossings that a moved box could remove; nothing clipped.
- [ ] Colours are tokens / `currentColor`; checked in light and dark (toggle OS or devtools).
- [ ] At 360 px wide the text is readable, either by scrolling inside the figure or by a
      narrow layout; the page itself does not scroll sideways.
- [ ] No CDN URL, no `on*=` attributes, unique marker ids, caption and `aria-label` present.
