---
name: pikchr
description: Load before drawing any diagram for an artifact page (architecture, data flow, sequence, state machine, boundary or before/after figure). Pikchr is the default diagram language - use it unless the user asks for another. The page holds the Pikchr source in <pre class="pikchr"> and the viewer renders it (light and dark SVG, page font) with Pikchr's wasm, which it only loads for pages that have a diagram. Covers the language including arcs and splines, the house style, polishing in Pikchr Studio through a #z= link, checking with render.mjs, and the pitfalls. Use with artifact-diagrams (what to draw) and artifact-design (the page around it).
---

# Pikchr diagrams for artifacts

Pikchr is the default for every diagram in an artifact. If the user names another tool or
framework, use that instead (see **artifact-diagrams**). The Pikchr source is the
diagram: it lives in the page and is versioned with it, and the SVG is derived from it.
Pikchr is also Fossil's own diagram language, and Fossil stores our artifacts.

**artifact-diagrams** decides *whether* a figure is worth it and *what* it should show.
This skill is *how* to draw it.

## How it renders

Write the source in the page, inside `<pre class="pikchr">`:

```html
<pre class="pikchr" aria-label="The CLI posts the page to the Worker API, which commits it to the Fossil repo; the viewer reads the files back.">
CLI:  box "publish CLI" fill 0xe7eef2
      arrow "POST" above
API:  box "Worker API" fill 0xe7eef2
</pre>
```

When the page opens, the viewer:

- loads Pikchr's wasm (about 56 KB compressed, cached by the browser) in a Web Worker,
  and only for pages that contain a `pre.pikchr`;
- replaces each block with a `<div class="pikchr-diagram">` holding a light and a dark
  SVG, swapped by `prefers-color-scheme` (or by `data-theme="light|dark"` on `<html>`);
- keeps the block's `id` and other classes on the div, and puts its `aria-label` (or
  `title`) on the SVG;
- shows a red error box in place of a block that fails to render. `publish` and `update`
  refuse such pages, so viewers should never see one.

Diagram text uses the page's font: the SVG inherits `font-family`, so a page set in
Instrument Sans (the default, see **artifact-design**) has Instrument Sans diagrams.
Wide diagrams keep at least 70% of their natural size and scroll sideways inside their
own box on a phone, rather than shrinking the text or making the page scroll.

Options on the `<pre>`:

- `data-theme="light"` or `"dark"` renders only that variant (for a page that is always
  dark, for example).
- In HTML, `<` followed by a letter starts a tag even inside `<pre>`. Write it as `&lt;`,
  and `&` as `&amp;`. Arrows like `<-` and `<->` are fine as they are.

A page's script can render Pikchr too, for example to redraw a diagram from data or
user input: `await window.artifact.pikchr(source)` returns
`{light, dark, width, height}` (SVG strings), or rejects with Pikchr's error message.

## Workflow

1. **Write the source** in the page's `<pre class="pikchr" aria-label="...">`. The
   `aria-label` tells the path in a sentence or two. Put a `<figcaption>` next to it (wrap
   both in `<figure>`) when the reader needs to know what to notice.
2. **Check it** until it renders: `node skills/pikchr/render.mjs page.html --check`
   checks every block in the page and prints errors with the offending line. A single
   source file or `-` (stdin) works too.
3. **Look at it.** Publish, open the read link, and screenshot it in light and dark if you
   can view images (Playwright: `colorScheme: 'dark'`). `render.mjs file --svg [--dark]`
   prints a bare SVG for a quick look. Fix overlaps, cramped labels and crossings using the
   style rules below. Do not hand over a diagram you have not looked at when you can look.
4. **Offer Pikchr Studio for polish.** Give the user the link from
   `node skills/pikchr/render.mjs source.pikchr --studio` (put the block's source in a
   file or pipe it in with `-`). See below.
5. **On every change,** edit the source in the page, `--check` it, `update` the artifact
   with a check-in message that names the diagram, and post the read link.

## Pikchr Studio: making it beautiful

[Pikchr Studio](https://pikchr-studio.daniel-mestas.workers.dev/) is a visual editor over
Pikchr source. Dragging, aligning, resizing, restyling arrows and editing text all become
edits to the source, and each edit is validated by Pikchr before it is applied. Nothing
leaves Pikchr's vocabulary, so what comes back is still plain Pikchr source that the
viewer renders identically.

- `--studio` prints `https://pikchr-studio.daniel-mestas.workers.dev/#z=<payload>`.
  The payload is the source compressed with raw DEFLATE and encoded as base64url; it
  stays in the URL fragment, so it is never sent to a server. Opening the link loads the
  diagram as a new Studio document; the user's earlier work stays in Saved documents.
  `PIKCHR_STUDIO_URL` overrides the origin.
- Send the link with one line on what to polish (for example "align the bottom row,
  give the arrow labels room"). Ask for the result back as source: in Studio, open `</>`
  (the source drawer) and copy it, or choose Download source in the ⤓ (export) menu. Do not take an
  exported SVG back, because the source is the diagram.
- Put what comes back into the page's `<pre class="pikchr">` in place of the old source
  (escape `<` before a letter as `&lt;`), `--check` it, `update` the artifact and post the
  read link. Keep the user's layout: do not reflow a diagram they placed by hand unless
  they ask.
- Studio keeps relational placement (`with .n at A.s`, `right of`) unless the user
  chooses otherwise, and writes absolute `at (x, y)` for objects they drag. Both are
  fine. Do not "clean up" one style into the other.
- Large diagrams make long links that some chat apps cut off. If the link is more than a
  few kilobytes, also give the source so the user can paste it into Studio's source
  drawer.

## The language in brief

Units are inches; 1 inch is 144 px in the SVG. Statements are separated by newlines or
`;`. A `\` at the end of a line continues it. `#` starts a comment.

```pikchr
# Objects: box circle ellipse oval cylinder file diamond dot text line arrow spline move arc
A: box "Two" "lines"             # label an object with "Name:"; strings stack as lines
   arrow                         # continues in the current direction (right by default)
B: cylinder "store" fit          # fit sizes the shape to its text
   down                          # change direction: right | down | left | up
C: box "next" with .n at B.s + (0, -0.6)
   arrow from B.s to C.n "reads" ljust   # explicit endpoints; text attrs follow strings
   arrow from A.s down 0.5 then right until even with C.w then to C.w   # orthogonal route
D: box "D" at (3, -1)            # absolute position: fine on a grid, and what Studio writes
```

- **Positions:** object anchors `.n .ne .e .se .s .sw .w .nw .c` (also `.start`/`.end` for
  lines); `last box`, `2nd last arrow`; arithmetic `A.e + (0.2, 0)`; `(A.c.x, B.c.y)`;
  `1/2 way between A.c and B.c`; `0.5 below A.s`, `right of`, `above`.
- **Size and style:** `wid` `ht` `rad` `thick` `thin` `dashed` `dotted` `invis`
  `fill 0xRRGGBB` `color 0xRRGGBB` `behind <object>` (draw underneath it).
- **Text attributes** come right after the string: `above` `below` `ljust` `rjust`
  `bold` `italic` `mono` `big` `small` `aligned` (follow a sloped line).
- **Variables** set defaults: `boxwid` `boxht` `boxrad` `linewid` `lineht` `thickness`
  `arrowht` `arrowwid` `fontscale` `margin`. User variables start with `$`
  (`$ink = 0x29333a`) and can be used wherever a number or colour goes.
- **Lines:** `chop` stops a line at the edge of the shapes it joins (`arrow from A to B chop`);
  `<->` and `<-` set arrowheads; `then` adds a segment; `close` closes a polygon.
- **Macros:** `define node { box $1 fill $base color $ink }` then `node("API")`.

Full reference: https://pikchr.org/home/doc/trunk/doc/userman.md and the grammar at
https://pikchr.org/home/doc/trunk/doc/grammar.md.

### Curves: arcs and splines

Straight and orthogonal lines are the default. Reach for a curve when it says something a
straight line can't, and in more complex diagrams use them deliberately:

- **`arc`** for a return or a loop: a retry back to an earlier state, a feedback path, a
  self-transition. `arc -> from Running.s to Queued.s cw` bows below the row (`cw` turns
  clockwise from start to end; without it the arc turns counter-clockwise, so add or drop
  `cw` to flip the bow). Pikchr draws an arc as one quadratic Bézier with a fixed,
  quarter-turn bow; `rad` does not change it. For a flatter or deeper curve, use a spline
  through a point you choose. An arc with no endpoints is a quarter circle in the current
  direction.
- **`spline`** for a path that must go around something: it runs through the points you
  give (`from`, each `then`, `to`) and smooths every corner into a Bézier curve.
  `spline -> from A.n up 0.35 then right until even with C.n then down 0.35 to C.n`
  bows over a box instead of crossing it. Give the first and last legs the direction the
  line should leave and enter the boxes (here `up` and `down`), or the ends kink.
- **Labels on curves** go where the curve has room, not on the line: inside an arc's bow
  (`at (A.s.x + B.s.x)/2, A.s.y - 0.32`), or just outside a spline's flat run. `aligned`
  text follows only straight segments, so don't use it on curves.
- Style a secondary or exceptional path (cancel, timeout, fallback) as `dashed` in
  `$muted`, and keep the main path solid in `$ink`. That way the reader sees the normal
  flow first.
- Don't curve a line just to look softer. If every edge curves, none of them stands out.

`skills/pikchr/examples/state-machine.pikchr` shows both: a retry arc under the row, and a
dashed cancel spline over it.

## House style

What separates a clean Pikchr figure from a default one. The examples in
`skills/pikchr/examples/` (`publish-flow.pikchr`, a flow with a boundary;
`state-machine.pikchr`, states with an arc and a spline) follow every rule here. Start
from them.

**Set the defaults once, at the top.**

```pikchr
fontscale = 1.1
boxwid = 1.3; boxht = 0.55; boxrad = 0.08
linewid = 0.85; thickness = 0.015
arrowht = 0.09; arrowwid = 0.06
$ink = 0x29333a; $muted = 0x53616c; $rule = 0x6b737b
$base = 0xe7eef2; $focus = 0xf6e7dc; $accent = 0x9a3f08
```

Uniform box sizes and one `linewid` give equal gaps and shared centre lines; that is
most of what makes a diagram look designed. Use `fit` only for one-off shapes.

**Colour for both themes.** Pikchr's dark mode inverts lightness and keeps hue. Dark
strokes and text become light ones, and very light fills become dark ones. **Mid-tones
barely change** (`0x8c8c8c` stays grey on a dark background) **or shift hue**
(`0x8a959e` turns bright blue). So:

- strokes and text: dark, lightness under about 45% (`$ink`, `$muted`, `$rule`, `$accent`);
- fills: very light tints (`$base`, `$focus`), or `fill none`;
- never pure `0x000000`/`0xffffff` and never a mid-grey;
- at most one accent, on the object the text is about, carried by more than colour:
  `bold`, `thick`, or the caption naming it;
- check both themes: open the read link in light and dark mode, or screenshot
  `render.mjs --svg` and `--svg --dark` on `#ffffff` and `#15171a`.

**Let the page set the font.** Don't pick fonts in Pikchr; the diagram inherits the
page's `font-family`, so it matches the text around it. Pikchr sizes boxes and positions
labels from its own estimate of text width, which is close to an average sans. With a
wide font, or with `fit`, check for labels that touch their box edges and widen the box.

**Name every object** (`API: box ...`). Names make relational placement readable, give
arrows stable endpoints, and are what the user sees in Studio's source drawer.

**Labels need room.** An arrow label is centred on the arrow; make the arrow at least the
label's width plus 0.25 in, or the text runs into the boxes. Vertical arrows take side
labels: `text "reads" ljust small at last arrow.c + (0.08, 0)`. Keep labels short
(1–3 words) and `small` for secondary notes.

**Boundaries go behind and clear of labels.** Draw a trust or process boundary as
`box dashed fill none color $rule rad 0.12 behind <first object>`, size it from the
anchors of what it contains (`wid Repo.e.x - API.w.x + 0.3`), and place it with an anchor
(`with .sw at (API.w.x - 0.15, API.s.y - 0.15)`). Check that no arrow label sits on its
edge, and put its own label inside a corner in `small italic $muted`.

**One reading direction; no crossings.** Main flow left to right; a secondary path drops
down. Route around shapes with `then` segments instead of crossing them. If two lines
must cross, move a box.

**Keep it narrow.** The natural width shows in `--check` (`ok: 827×344 px`). Under about
840 px the figure fits a desktop column and scrolls only on phones. A long chain of five
or more boxes reads better as two rows, or top to bottom with `down`.

## Pitfalls

- Text attributes (`ljust`, `above`, `small`, `bold`) must come right after the string
  they modify; `text "x" small at P ljust` is a syntax error.
- `with .n at X` places the object's anchor at X; `at X` places its centre.
- `behind` takes an object, and the object must already exist. Draw the contents first,
  then the boundary.
- `$name` variables must be assigned before use; numbers and colours only, no strings.
- A label string on a line goes before positioning words in practice:
  `arrow "POST" above` reads more clearly than mixing it into `from ... to ...`.
- Rendered blocks are static. To redraw a diagram from data or user input, build the source
  in script and call `window.artifact.pikchr(source)`. For highlighting parts of one
  drawing or a chart of numbers, use hand-written SVG per **artifact-diagrams** or
  **artifact-dataviz**.
- Don't paste rendered Pikchr SVG into a page. Keep the source in `pre.pikchr`, so the
  diagram can be edited, follows the theme and uses the page font.

## Checklist

- [ ] Source is in the page as `<pre class="pikchr" aria-label="...">`, with `<` before a
      letter escaped.
- [ ] `render.mjs page.html --check` passes; natural width is about 840 px or less, or the
      flow is vertical.
- [ ] Looked at both themes: no overlapping text, no label on a boundary, no crossings.
- [ ] Only dark strokes and very light fills; one accent, also shown by weight.
- [ ] Curves only where they mean something (a return, a detour); labels off the line.
- [ ] `aria-label` tells the path in a sentence or two; a caption says what to notice.
- [ ] Offered the Studio link; any polished source that came back replaced the block.
- [ ] Posted the read link after publishing or updating.
