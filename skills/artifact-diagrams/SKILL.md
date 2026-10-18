---
name: artifact-diagrams
description: Load before putting a diagram - architecture, data flow, sequence, state machine, before/after comparison, timeline or any box-and-arrow figure - into an HTML page that will be published as an artifact through this repo's viewer. Covers when a diagram is worth drawing, how to show the real mechanism, and layout, labels and arrows. Pikchr is the default (load the pikchr skill; the viewer renders it), polished in Pikchr Studio; another framework only when the user asks for one; hand-written inline SVG for interactive figures. Use with artifact-design (page design) and publish-html-page (publishing); for charts of numbers load artifact-dataviz instead.
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

- **Pikchr by default.** Unless the user asks for something else, a diagram is Pikchr
  source in `<pre class="pikchr">` in the page. The viewer renders it, loading Pikchr's
  wasm only for pages that have one. Polish it in Pikchr Studio. Load the **pikchr**
  skill for the language, the house style and the Studio loop.
- **Another framework when the user asks for one** (Mermaid, Graphviz, D2, ...): see
  "Other diagram tools" below. Nothing ships that the page doesn't use.
- **Hand-written inline SVG for interactive figures** (toggle before and after,
  highlight a path), where the page's script needs to reach into the drawing; see
  "Interactive figures" below.
- **No inline event handlers.** `onclick=` / `onmouseover=` are blocked. If parts of the
  diagram are interactive (highlight a path, toggle "before / after"), attach listeners with
  `addEventListener` in an inline `<script>`.
- **Theme follows the OS.** The viewer renders Pikchr in light and dark and swaps them
  with `prefers-color-scheme`; hand-written SVG uses CSS custom properties.
- **Phone to desktop.** The viewer gives the page the full width under its top bar - as little
  as ~360 px on a phone.
- **No image export from the page.** Downloads are blocked in the viewer. The Pikchr
  source is in the page; anyone who needs the figure elsewhere can open it in Pikchr
  Studio and export SVG or PNG there.

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
- **Use a grid.** One box size and one gap for the whole figure (in Pikchr: `boxwid`,
  `boxht` and `linewid` set once at the top). Equal gaps and shared centre lines are what
  make a diagram look intentional.
- **Arrows are straight or orthogonal.** Horizontal and vertical segments; one bend at most
  where possible. Avoid crossings - move a box before you add a crossing.
- **Boundaries are regions.** A dashed rounded rect behind the boxes, labeled in its corner
  ("browser sandbox", "server", "Fossil repo"), shows a trust or process boundary better than
  a note.
- **Leave room.** Labels never touch a box, a boundary or another label.

## Labels and arrows

- **Every arrow says what it carries** unless the meaning is obvious and identical everywhere:
  `POST /api/publish`, `check-in`, `polls 60 s`, `reads (token)`. Put the label just above the
  midpoint of a horizontal arrow, or beside a vertical one.
- **Box labels are names, 1-3 words.** Detail goes in a second, smaller line or in the caption.
  Sentences inside a diagram are a sign the text belongs in the prose.
- **Encodings are few and explained.** Solid = synchronous call, dashed = async / eventual is
  fine, but if you use it, add a two-item key under the figure. If an encoding appears once,
  label the mark instead of adding a legend.
- **One accent colour** for the element the text is about; everything else in ink and muted
  ink. Colour that does not mean anything is noise.

## Interactive figures: hand-written SVG

Use this only when the page's script must change the drawing. For everything else, use
Pikchr.

- **Text size 12-14 px at the drawn scale,** never below ~10 px after the figure is scaled to
  phone width (see below). Use `text-anchor="middle"` and `dominant-baseline="middle"` to
  centre labels in boxes instead of guessing offsets.
- **Arrowheads** come from one `<marker>` in `<defs>`, referenced by `marker-end`. Give the
  marker `fill: currentColor` so its colour matches the line in both themes.
- **Leave 12-16 px inside the viewBox edge** so strokes and labels are never clipped.


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

### Example: box-and-arrow with a marker arrowhead

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
                 color: var(--ink); font-size: 13px; line-height: 1; }
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

### Interactivity

Most diagrams should be static. When interaction answers a real question - "show only the
write path", "compare before and after" - use real `<button>`s above the figure and toggle
classes on SVG groups with `addEventListener('click', ...)`. Keep both states drawable on the
same grid so toggling moves nothing that did not change. Respect `prefers-reduced-motion`
(no animated transitions when it is set). Do not store the toggle state in `localStorage` -
it throws in the sandbox; if it must persist, use `window.artifact.data`, and remember that
writes need the edit link.

## Phone width

Pikchr diagrams handle this already: the viewer lets them shrink to 70% of natural size
and then scroll inside their own box. Keep their natural width around 840 px or less, or
lay the flow out top to bottom. For hand-written SVG:

- `viewBox` + `width: 100%; height: auto` is the baseline. Compute the scale: a 640-wide
  viewBox on a 340 px content column shrinks 13 px text to ~7 px - too small.
- Choose per figure: (a) a `min-width` plus a horizontal scroll container (as above) for wide
  flows; (b) a second, vertical layout of the same diagram for narrow screens, swapped by a
  CSS media query (`.wide { display: none }` under `max-width: 520px`, and the reverse); or
  (c) design top→bottom from the start when the flow allows it - tall diagrams scroll
  naturally on phones.
- Do not rely on hover to reveal labels; touch has no hover.

## Other diagram tools

Use another tool when the user names one, or when a figure needs automatic layout that
Pikchr doesn't do (a graph of dozens of nodes; though first ask whether a smaller diagram
of the part that matters would serve better). The page can't reach the network, so:

- **Runs in the page:** vendor the library's classic (UMD) build as a file in the published
  directory (`<script src="vendor/lib.min.js">`; the viewer inlines it). It must not need
  `eval`, `new Function`, WebAssembly or network access, and its file must stay under about
  1.99 MB compressed. Ship only the build you use. Open the read link and check that it
  actually draws before sharing.
- **Can't run in the page** (for example a Graphviz build that needs WebAssembly): render
  to SVG with the tool's own CLI when you write the page, inline the SVG, and replace its
  hard-coded colours with theme tokens. Publish the source next to it (e.g.
  `diagrams/deps.dot`) so it can be edited and re-rendered later.

Whatever the tool, the rules above still apply: show the mechanism, label the arrows,
follow the theme, stay readable at phone width.

## Accessibility

- Wrap each diagram in `<figure>` with a `<figcaption>` stating what it shows.
- Give the `<svg>` `role="img"` and an `aria-label` that tells the same story in one or two
  sentences - the path, not a list of box names (for Pikchr, the `aria-label` on the `<pre>`).
- Text and lines reach 4.5:1 / 3:1 against the surface in both themes; the accent is never
  the only carrier of meaning (pair it with a heavier stroke, a label, or the caption).
- For complex flows, the prose next to the figure should also state the steps in order.

## Before publishing

- [ ] The diagram shows a mechanism or a difference the text depends on; a sentence wouldn't do.
- [ ] Every arrow is labeled or its meaning is stated once in a key.
- [ ] Shapes sit on a grid; no crossings that a moved box could remove; nothing clipped.
- [ ] Drawn in Pikchr with the source published next to the page (or hand SVG because it is
      interactive); checked in light and dark.
- [ ] At 360 px wide the text is readable, either by scrolling inside the figure or by a
      narrow layout; the page itself does not scroll sideways.
- [ ] Offered the Pikchr Studio link for polish.
- [ ] No CDN URL, no `on*=` attributes, caption and `aria-label` present.
