---
name: artifact-design
description: Design rules and the page contract for HTML pages published with html-artifact-publisher. Load it before writing any HTML page (or directory of files) that will be published or updated with this publisher, including revisions of an existing artifact, and before turning Markdown or notes into a page.
---

# Artifact design

A published page is shown by our viewer inside a sandboxed iframe, under the
viewer's own 52 px bar, with a strict Content-Security-Policy and no network.
This skill covers what the page must do to render correctly there, and how to
make it look considered rather than generated. Publishing itself is covered by
**publish-html-page**; the `window.artifact` API (stored data, history,
pages that publish themselves) by **artifact-runtime**; diagrams by
**artifact-diagrams** and **pikchr** (drawn in Pikchr, polished in Pikchr Studio); charts and dashboards by **artifact-dataviz**.

## 1. Page contract (hard rules)

Break any of these and the page silently fails for every viewer.

**Everything ships inside the artifact.** The CSP allows no external host:
no CDN scripts, no Google Fonts, no remote images, no `fetch` to other sites.
The CLI warns about any `http(s)` URL it finds; treat that warning as an error.
- Scripts and styles: inline `<script>` / `<style>`, or relative files in the
  published directory (`<script src="app.js">`, `<link rel="stylesheet"
  href="site.css">`). The viewer inlines those and adds the CSP nonce.
- Images, fonts, audio, video: relative files (the viewer turns them into
  `data:` URLs), or things generated in script (canvas, `Blob` URLs). The
  house fonts are the exception: name them in CSS and the viewer embeds them
  (see Typography).
- A library is a vendored file in the directory, loaded with a plain
  `<script src>`, using its UMD/global build. It must not need `eval`,
  `new Function`, string `setTimeout`, or WebAssembly (all blocked). Skip
  template compilers and expression evaluators. Most pages need no library.

**What the viewer does not resolve.** ES module `import` of relative files,
`fetch()`/XHR of relative files, `srcset`, CSS `@import`, `<iframe src>`, and
workers loaded from files. Use classic scripts that share globals, list them in
dependency order, and put one image per `src`. If script needs a file's text,
use `window.artifact.read(path)` (see artifact-runtime).

**No inline handlers.** `onclick="…"` and `javascript:` URLs are blocked.
Attach behavior with `addEventListener`. `style="…"` attributes are fine.

**No browser storage.** The iframe has an opaque origin, so `localStorage`,
`sessionStorage`, IndexedDB and cookies throw. Persist through
`window.artifact.data` (artifact-runtime), and check `canWrite()` before
offering any control that writes; a read link must show a read-only state.

**No downloads, no printing to file.** `<a download>` and script-driven saves
do nothing. Never offer "Download" or "Export file". Show the output in a
`<textarea>` or `<pre>` with a Copy button; the clipboard may be refused, so
catch the rejection and select the text instead.

**Other sandbox facts.** `alert`/`confirm`/`prompt` work, but a designed
in-page confirmation reads better. Forms post nowhere: handle `submit` with
`preventDefault()`. `target="_blank"` links open new tabs; the page cannot
navigate the viewer, read the URL fragment, or reach the parent. Camera, mic,
geolocation and clipboard-read are unavailable; take files through
`<input type="file">` instead.

**Size.** Each file must compress (zlib) to under about 1.99 MB, and one
publish request is at most 10 MB. Optimize images, subset fonts, split large
data into separate files, and do not vendor a large library for a small job.

**Write a full document.** The viewer renders your entry file as is: include
`<!doctype html>`, `<meta charset="utf-8">`, a viewport meta, and a `<title>`.
A directory's entry is `index.html` (else the first `.html` file).

## 2. Read the request: choose a treatment

Every page gets design; what changes is how much.

- **Utilitarian** (most requests: a report, plan, memo, explainer, review,
  checklist, small tool). Real type hierarchy, a deliberate palette, careful
  spacing, and no spectacle. No giant hero, at most one tasteful flourish.
- **Editorial** (a landing page, a game, a showcase, a tool people will keep
  and share). Take a point of view: see section 8.

When unsure, choose utilitarian. A well-composed plain page is never wrong; an
over-styled one often is.

## 3. Fundamentals

**Defer to what exists.** If the repo, CLAUDE.md, or an earlier version of the
artifact has tokens, fonts or component styles, reuse them. Precedence: the
user's words, then the existing system, then your own choices. When revising,
keep the page's look unless asked to change it.

**Ground it in the subject.** Name the one subject, its reader, and the page's
single job. Draw choices from that subject's world: its units, its document
conventions, its vocabulary. Include at least one detail only this subject
would have, as content (a real tolerance, a real field name, a real date
format). Use real content, never lorem ipsum.

**Typography.** Unless the user names a font, set pages in **Instrument
Sans**: neutral but with character, good for both headings and running text.
Add an IBM Plex face when the task calls for it:

| Role | Font | Use it for |
|---|---|---|
| Default (body and headings) | `"Instrument Sans"` | almost everything |
| Code and data | `"IBM Plex Mono"` | code, IDs, hashes, terminal output, aligned numbers |
| Long reading | `"IBM Plex Serif"` | essays, reports and letters meant to be read start to finish |
| Engineered, dense | `"IBM Plex Sans"` | technical references, specs and dense tool UIs |

The viewer embeds these four itself, and only into pages whose CSS names them:
Latin-only woff2 subsets, roughly 15–50 KB per face. Italic files ship only if
the page can show italics, and Plex Mono and Serif bold files only if it shows
bold. So don't name a family you don't use, and don't add an `@font-face` for
them. Always give a fallback stack:
`font-family: "Instrument Sans", system-ui, -apple-system, "Segoe UI", sans-serif;`
`font-family: "IBM Plex Mono", ui-monospace, Menlo, Consolas, monospace;`

**If the user wants another font,** use it. No webfont service is reachable, so ship a
subset `.woff2` in the published directory (`fonts/display.woff2`), declared
with `@font-face { font-family: "Display"; src: url(fonts/display.woff2)
format("woff2"); }` plus a full fallback stack. Keep it to one or two faces of
tens of KB each. A page that declares its own `@font-face` for a family keeps
it; the viewer doesn't replace it. A plain system stack is also fine when the
user asks for one.

Set a short type scale and stick to it. Keep running text near 65 characters
per line, body line-height around 1.5, headings `text-wrap: balance`, and add
slight letter-spacing to uppercase labels. Use
`font-variant-numeric: tabular-nums` where digits align in columns.

**Neutrals.** Choose the greys. Tint them slightly toward the accent hue so
they look intended. Pure white or near-black grounds are fine when chosen.

**Both themes through tokens.** The viewer has no theme toggle and never sets a
`data-theme` attribute; the page follows the OS through
`prefers-color-scheme`. Define every color once on `:root` (light values),
redefine only the tokens inside the dark media query, and style every
component through tokens. `body` must set an explicit `background` and `color`
because the iframe is white by default. Give dark its own care: lower the
accent's lightness or saturation so it doesn't glare, and recheck contrast.
A page with one deliberate look (a terminal screen, a poster) may skip the dark
block, but still sets every color explicitly.

```css
:root {
  /* Layout: single reading column, wide figures break out to 960px */
  --bg: #fbfaf8;   --surface: #f1efeb; --fg: #1d1c1a;
  --muted: #6b6760; --line: #dcd8d1;  --accent: #2f5d8a;
  --ok: #2e7d4f;   --warn: #a86a00;   --bad: #b3261e;
  --font-body: "Instrument Sans", system-ui, -apple-system, "Segoe UI", sans-serif;
  --font-mono: "IBM Plex Mono", ui-monospace, Menlo, Consolas, monospace;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #141517;   --surface: #1d1f22; --fg: #e8e6e2;
    --muted: #a19d96; --line: #34363a;  --accent: #8db4dc;
    --ok: #6cc28f;   --warn: #e0a64a;   --bad: #f08a80;
    color-scheme: dark;
  }
}
body { background: var(--bg); color: var(--fg); font-family: var(--font-body); }
```

**Layout and spacing.** Space sibling groups with flex or grid and `gap`, not
per-element margins. Keep a side gutter of at least 16 px at every width. Watch
selector specificity so one rule doesn't quietly undo another's spacing.

**Respect the viewer bar.** The page sits below the viewer's 52 px bar, which
already shows the title, version, Share and Comment. Do not add a fixed
full-width top bar that repeats it; a page header that scrolls away, or a
sticky in-page toolbar for a tool, is fine. Avoid `100vh` heroes: the frame is
shorter than the window, and a full-height opener hides everything else. For
a one-screen app, use `html, body { height: 100% }` and let the layout fill it.

**Phone width.** Pages must work from about 360 px to wide desktop, and the
body must never scroll sideways. Use relative units; let rows wrap or collapse
to one column; give flex/grid children that hold text, code or tables
`min-width: 0`; put `max-width: 100%` on images and aspect-ratio boxes; never
set a `min-width` wider than a phone. Only tables, code and diagrams may be
wider, each inside its own `overflow-x: auto` wrapper.

**Consistent repeats.** Cards in a row, label/value lists, badges on siblings:
same padding, same edges, same baseline, recurring parts in the same place.
Let content set height. Pick a column count the items fill, so nothing stands
alone in a row or stretches over blank space. Clipped text is a bug: wrap it
or scroll it in its own container.

**Card styling by role.** Border, fill, radius and shadow each say "separate
object". Use them for the one element that needs setting apart, not every
block. Lead with big-number tiles only when those numbers are the point.

**Charts to scale.** One scale for marks, ticks and labels; labels name values
the data reaches; text colored from tokens; nothing overlapping or clipped (in
SVG, leave viewBox room for outer labels and give every shape an explicit
fill). Details in **artifact-dataviz** and **artifact-diagrams**.

**Complete at rest.** Everything meant to be read is visible on load, without
scrolling or interaction to reveal it. Animations start from a visible state;
never leave content at `opacity: 0` waiting for an observer. A tool opens in a
working state: the user's real data, or a clearly labeled sample, not an empty
shell. When data comes from `window.artifact.data`, render a designed loading
or empty state first ("No entries yet. Add the first one below."), then fill
it.

**Avoid the generated look.** Unless the user asks for it, steer clear of the
current defaults: cream background with serif display and terracotta accent;
near-black with one neon accent; purple-to-blue gradient heroes; emoji as
section icons; everything centered; the same large radius and shadow on every
box; colored accent rails on rounded cards; numbered "01 / 02 / 03" markers on
content that is not a sequence.

**Build cleanly.** Close every element, double-quote attributes, give focus a
visible style, honor `prefers-reduced-motion`, label every form control, give
controls stable `id`s, use semantic elements (`header`, `main`, `nav`,
`button` for actions, `a` for links), and add `alt` text to meaningful images.
Keep text contrast at WCAG AA in both themes. For decorative or generative
graphics, draw on canvas rather than writing long SVG paths by hand.

## 4. Copy

Words are part of the design. Write from the reader's side: name things the
way they recognize them, not by internal mechanism. Use active voice; a button
says what it does ("Save entry") and the confirmation says what happened
("Saved"). Error text says what went wrong and how to fix it, with no apology
("Read-only link: open the edit link to save changes."). Prefer plain and
specific over clever. Avoid mannered tics: em-dash asides, "not X but Y"
constructions, colon reveals, scare quotes, stock filler phrases.

## 5. Naming the artifact

The CLI `--title` option names the artifact in the viewer bar and in
`list` (without it the filename is used, so always pass it). The page's
`<title>` sets the browser tab; give both the same name. Make it a name, not a
caption: a short, specific noun phrase, usually two to four words, that picks
this artifact out of a long list ("Q3 Freight Audit", "Kiln Firing Log").
If the user already calls the thing something, use that. No generic labels
alone ("Report", "Dashboard"), and no explanation after a dash or colon; put
the explanation in the page's opening line or the check-in `--message`. Keep
the title stable across updates.

## 6. Structure is information

Eyebrows, numbering, dividers and labels must say something true about the
content. Number steps only when order matters. Use a label only when the
reader needs it to orient. If removing a device loses no information, remove
it.

## 7. UI pages vs documents

**Documents** (reports, explainers, plans) are read top to bottom: invest in
type, measure, rhythm, and a clear heading outline; in-page `#id` links work
for a table of contents.

**UI pages** (dashboards, trackers, tools) are scanned and operated: summary
before detail; state shown by form as well as number (pills, chips, a severity
stripe); semantic colors (`--ok`, `--warn`, `--bad`) kept separate from the
accent; controls that look clickable; disabled/read-only states when
`canWrite()` is false. Shared state lives in `window.artifact.data`; there are
no push events, so poll sparingly (every 30-60 s while visible) only if the
page needs other viewers' changes. See **artifact-runtime**.

## 8. Process

1. **Decide what the viewer does**, not only what they read. If the page
   stores input, shows shared state, or rewrites itself, load
   **artifact-runtime** before designing.
2. **Write the plan as tokens.** At the top of the `<style>`, write the
   `:root` block: a one-line layout comment, 4-6 named color tokens plus
   semantic ones if needed, and font tokens for each role (display, body,
   utility). Build every later rule from those tokens. Don't narrate the plan
   to the user beyond one sentence on direction.
3. **Editorial requests only:** before building, reread the plan against the
   subject. Replace any part that would fit any similar page. Then commit:
   the opening shows the most characteristic thing in the subject (a headline,
   an image, a live demo); typography carries the personality; one
   orchestrated motion moment beats scattered effects; put the boldness in
   one place and keep the rest quiet; execute minimal directions with
   precision and maximal ones fully.
4. **Build**, as one file or a directory (`index.html` plus relative css, js,
   images, a font). Remember the inlining limits in section 1.
5. **Self-check once, then publish** with **publish-html-page**. One quick
   pass, not a loop:
   - `grep -nE 'https?://|onclick=|on[a-z]+="|javascript:|localStorage|sessionStorage|download|import |fetch\(' ` over your files; every hit is either legitimate (a plain outbound `<a href>`) or must go.
   - Every color comes from a token defined on `:root`; `body` sets background
     and color; the dark block only redefines tokens.
   - No fixed full-width top bar, no `100vh` hero, nothing wider than 360 px
     outside an `overflow-x: auto` wrapper.
   - `<title>` is a real name; content is visible at rest.
   - If you can render locally (a headless browser screenshot at phone and
     desktop width), look once and fix what you see. For logic-heavy pages,
     one run of the core function on sample input is enough.
   For revisions, use `update <edit-url>` with a clear `--message`, not a new
   publish.

## 9. Minimal skeleton that passes the CSP

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kiln Firing Log</title>
<style>
  :root {
    /* Layout: one column, 44rem measure, table scrolls on phones */
    --bg: #fafaf7; --fg: #1f1e1b; --muted: #6a675f; --line: #dad6cd;
    --accent: #8a4b2a; --font: "Instrument Sans", system-ui, -apple-system, "Segoe UI", sans-serif;
    color-scheme: light;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #161513; --fg: #ebe8e1; --muted: #a39f95; --line: #36332e;
            --accent: #e0a07a; color-scheme: dark; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.5 var(--font); }
  main { max-width: 44rem; margin: 0 auto; padding: 24px 16px 48px;
         display: grid; gap: 16px; }
  h1 { margin: 0; font-size: 1.75rem; text-wrap: balance; }
  .note { color: var(--muted); margin: 0; }
  button { font: inherit; color: var(--bg); background: var(--accent);
           border: 0; border-radius: 6px; padding: 8px 14px; cursor: pointer; }
  button:focus-visible { outline: 2px solid var(--fg); outline-offset: 2px; }
  @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
</style>
</head>
<body>
<main>
  <h1>Kiln Firing Log</h1>
  <p class="note" id="status">Cone 6 oxidation, last firing peaked at 1222 °C.</p>
  <button type="button" id="toggle">Show schedule</button>
  <pre id="schedule" hidden>Ramp 1: 100 °C/h to 600 °C
Ramp 2: 150 °C/h to 1222 °C, hold 10 min</pre>
</main>
<script>
  const btn = document.getElementById('toggle');
  const pre = document.getElementById('schedule');
  btn.addEventListener('click', () => {
    pre.hidden = !pre.hidden;
    btn.textContent = pre.hidden ? 'Show schedule' : 'Hide schedule';
  });
</script>
</body>
</html>
```

No external URLs, no inline handlers, no storage, explicit body colors, both
themes from tokens, and it reads correctly at 360 px.
