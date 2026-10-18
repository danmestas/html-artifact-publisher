---
name: pikchr
description: Load before drawing any diagram for an artifact page (architecture, data flow, sequence, state machine, boundary or before/after figure). Diagrams are written in Pikchr, rendered to theme-aware inline SVG with the bundled render.mjs (no network, no build), polished in Pikchr Studio through a #z= link, and kept as .pikchr source next to the page so they are versioned with it. Covers the language, the house style, the Studio loop, and the pitfalls. Use with artifact-diagrams (what to draw) and artifact-design (the page around it).
---

# Pikchr diagrams for artifacts

Every diagram in an artifact is a [Pikchr](https://pikchr.org) program. The `.pikchr`
source is the diagram; the SVG in the page is generated from it and never edited by hand.
Pikchr is Fossil's own diagram language, and Fossil stores our artifacts, so the source
lives in the same repository and history as the page it illustrates.

**artifact-diagrams** decides *whether* a figure is worth it and *what* it should show.
This skill is *how* to draw it.

## Why the page carries SVG, not Pikchr

The viewer's CSP blocks WebAssembly and all network access, so a page cannot render
Pikchr when it is viewed. You render at authoring time with `skills/pikchr/render.mjs`,
which runs the same wasm build Pikchr Studio uses (vendored in `skills/pikchr/vendor/`,
Node 18+, no install), and paste the output into the page.

The output is a `<figure>` with two inline SVGs, one rendered in Pikchr's light mode and
one in its dark mode, swapped by `prefers-color-scheme`, plus a small `<style>` block. It
has no scripts and no external URLs. It keeps a minimum width of 70% of the diagram's
natural size and scrolls sideways inside its own box below that, so text stays readable
on a phone without the page scrolling sideways.

## Workflow

1. **Write the source** in the artifact directory, e.g. `diagrams/publish-flow.pikchr`.
   Publish the page as a directory (`publish-html.mjs dir/`) so the source is checked in
   with every version of the page.
2. **Check it** until it renders:
   `node skills/pikchr/render.mjs diagrams/publish-flow.pikchr --check`.
   Errors print the offending line with a caret; the exit code is 1.
3. **Look at it.** If you can view images, render the figure into a scratch HTML page and
   screenshot it in light and dark (Playwright: `colorScheme: 'dark'`). Fix overlaps,
   cramped labels and crossings now, using the style rules below. Do not publish a
   diagram you have not looked at when you can look.
4. **Render the figure:**
   ```sh
   node skills/pikchr/render.mjs diagrams/publish-flow.pikchr \
     --alt "The CLI posts the page to the Worker API, which commits it to the Fossil repo; the viewer reads the files back." \
     --caption "Each publish is a Fossil check-in." --out diagrams/publish-flow.html
   ```
   Paste the contents of the `.html` output into `index.html` where the figure goes. The
   viewer does not include HTML fragments by itself. With several figures, pass
   `--no-style` to all but one (they share the same rules).
5. **Offer Pikchr Studio for polish.** Give the user the link from
   `node skills/pikchr/render.mjs diagrams/publish-flow.pikchr --studio` (see below).
6. **On every change to the source,** re-run step 4, replace the figure in the page, and
   `update` the artifact with a check-in message that names the diagram.

## Pikchr Studio: making it beautiful

[Pikchr Studio](https://pikchr-studio.daniel-mestas.workers.dev/) is a visual editor over
Pikchr source. Dragging, aligning, resizing, restyling arrows and editing text all become
edits to the source, and each edit is validated by Pikchr before it is applied. Nothing
leaves Pikchr's vocabulary, so what comes back is still a plain `.pikchr` file that
`render.mjs` renders identically.

- `--studio` prints `https://pikchr-studio.daniel-mestas.workers.dev/#z=<payload>`.
  The payload is the source compressed with raw DEFLATE and encoded as base64url; it
  stays in the URL fragment, so it is never sent to a server. Opening the link loads the
  diagram as a new Studio document; the user's earlier work stays in Saved documents.
  `PIKCHR_STUDIO_URL` overrides the origin.
- Send the link with one line on what to polish (for example "align the bottom row,
  give the arrow labels room"). Ask for the result back as source: in Studio, open `</>`
  (the source drawer) and copy it, or choose Download source in the ⤓ (export) menu. Do not take an
  exported SVG back, because the source is the diagram.
- Save what comes back over the `.pikchr` file, `--check` it, render it, and update the
  artifact. Keep the user's layout: do not reflow a diagram they placed by hand unless
  they ask.
- Studio keeps relational placement (`with .n at A.s`, `right of`) unless the user
  chooses otherwise, and writes absolute `at (x, y)` for objects they drag. Both are
  fine. Do not "clean up" one style into the other.
- Large diagrams make long links that some chat apps cut off. If the link is more than a
  few kilobytes, also give the `.pikchr` source so the user can paste it into Studio's
  source drawer.

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

## House style

What separates a clean Pikchr figure from a default one. The example in
`skills/pikchr/examples/publish-flow.pikchr` follows every rule here; start from it.

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
- after rendering, check both SVGs. `render.mjs` prints both; screenshot them on
  `#ffffff` and `#15171a`.

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
- The figure is static. For an interactive figure (toggle before and after, highlight a
  path) or a chart of numbers, use hand-written SVG per **artifact-diagrams** or
  **artifact-dataviz**.

## Checklist

- [ ] Source saved as `diagrams/<name>.pikchr` and published with the page.
- [ ] `--check` passes; natural width is about 840 px or less, or the flow is vertical.
- [ ] Looked at both themes: no overlapping text, no label on a boundary, no crossings.
- [ ] Only dark strokes and very light fills; one accent, also shown by weight.
- [ ] `--alt` tells the path in a sentence or two; the caption says what to notice.
- [ ] Offered the Studio link; any polished source that came back replaced the file and
      was re-rendered.
