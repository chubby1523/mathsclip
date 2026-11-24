# How MathsClip works

This is a tour of the code for anyone who wants to change it. MathsClip is a Manifest V3 Chrome extension written in plain JavaScript. It has no build step and no runtime dependencies.

## The pieces

| Part | Files | Runs in |
|---|---|---|
| Service worker | `src/background.js` | The background. It wakes for events and sleeps when idle. |
| Content scripts | `src/defaults.js`, `src/extractors.js`, `src/serializer.js`, `src/content.js` | Every page, in Chrome's isolated world |
| MathJax bridge | `src/main-world.js` | Every page, in the page's own JavaScript world |
| Settings popup | `src/popup/` | The toolbar popup |

**Service worker.** It registers the two right-click menu items. When one is clicked, it messages the content script in that tab and frame (`COPY_SELECTION` or `COPY_EQUATION`). It can't see the page itself.

**Content scripts.** These share the page's DOM but not its JavaScript variables. That's enough for most renderers, because KaTeX, Wikipedia and others leave the LaTeX in the HTML.

**MathJax bridge.** MathJax 3 and 4 often keep the LaTeX only in JavaScript memory (`window.MathJax.startup.document.math`), which the isolated world can't read. So `main-world.js` runs in the page's world, finds each equation's TeX and writes it onto the element as `data-cm-tex` and `data-cm-display` for the content scripts to read. It also handles MathJax 2 (`MathJax.Hub`). It only writes an attribute when the value has changed, so pages that watch for DOM changes don't get stuck in a loop. When the content script needs fresh data, it fires a `copy-math:sync` event to ask for a rescan.

**Settings.** Settings live in `chrome.storage.sync`, with defaults in `src/defaults.js`. The service worker and content scripts listen for changes, so a toggle in the popup takes effect straight away without reloading tabs.

**On-page UI.** The hover highlight, the "Click to copy" label and the toast sit inside a closed shadow root (`#copy-math-ui-host`). Page CSS can't restyle them, and their CSS can't leak into the page. The label ignores the mouse (`pointer-events: none`); you click the equation itself.

## Where the LaTeX comes from

`extractors.js` finds the outermost maths element under a point or inside a selection, then reads its LaTeX:

| Renderer | What's in the page | Where the LaTeX is |
|---|---|---|
| KaTeX | `.katex`, containing `.katex-mathml` and `.katex-html` (`.katex-display` for display maths) | `<annotation encoding="application/x-tex">` |
| MathJax 3 / 4 | `<mjx-container>` | `data-cm-tex` from the bridge, or an annotation in `mjx-assistive-mml` |
| MathJax 2 | `.MathJax` span next to a `<script type="math/tex">` | The script's text, or `MathJax.Hub` via the bridge |
| Wikipedia | `.mwe-math-element`, with MathML and a fallback image | The `data-mw` JSON, the annotation, or the image's `alt`, with `{\displaystyle …}` removed |
| Google Search | `[data-xpm-copy-root]` around equation images | `data-xpm-latex` on the root, or on each image joined together |
| MathML | `<math>` | A TeX annotation, or the `alttext` attribute |
| LaTeX images | `img.latex`, CodeCogs and `latex.php` images | The `alt` text or the URL's query string |
| Data attributes | `[data-latex]`, `[data-tex]`, `[data-math]` | The attribute itself, ignoring flags like `data-math="true"` |

Annotations with a `text/plain` encoding are skipped, because they hold spoken text ("x equals …") rather than TeX.

## The three ways to copy

**Ctrl+C.** `content.js` listens for `copy` on `window` in the capture phase, so it runs before the page's own handlers. It does nothing if the setting is off, if the copy is inside an editable field, or if the selection has no maths. Otherwise:

1. It asks the bridge to rescan, which catches MathJax equations added since the page loaded.
2. It widens the selection so half-selected equations are copied whole (`expandRangeForMath` in `serializer.js`).
3. It serialises the selection, replacing each equation with its delimited LaTeX.
4. It writes `text/plain`. In Plain Text mode it also writes `text/html` with the maths swapped, so Docs and Word keep the formatting.
5. It calls `preventDefault()` and `stopImmediatePropagation()`, so a page's own copy handler (Google's, for example) can't overwrite the result.

**Right-click.** `content.js` remembers what was right-clicked (`lastRightClickTarget`). When a menu item is chosen, it copies the selection or that equation with `navigator.clipboard`. If the page blocks that, it falls back to a hidden textarea and `execCommand("copy")`, then restores your selection. If **Override MathJax menu** is on, it stops MathJax's own menu from opening so Chrome's appears.

**Click-to-Copy** (off by default). A `mousemove` listener, throttled to one check per frame, finds the equation under the pointer and positions the highlight. A click only copies if the mouse moved 5px or less. A selection elsewhere also stops it, so dragging to select text still works normally.

## Why there are no modules

Content scripts listed in `manifest.json` load as classic scripts, not ES modules. So the shared files attach to a `globalThis.CopyMath` object instead of using `import`/`export`. They also set `module.exports` when it exists, so the same files load in:

- the content scripts
- the service worker (`importScripts("defaults.js")`)
- the popup (`<script src="../defaults.js">`)
- the Node tests (`require("../src/…")`)

## Folder layout

```text
manifest.json
icons/                 icon.svg and the 16, 32, 48 and 128px PNGs
src/
  defaults.js          default settings, delimiters, formatTex(), storage helpers
  main-world.js        MathJax bridge
  extractors.js        finding maths in the page and reading its LaTeX
  serializer.js        turning a selection into text or HTML with LaTeX
  content.js           copy handling, right-click, Click-to-Copy, on-page UI
  background.js        right-click menu
  popup/               settings popup
  fonts/               subset Computer Modern fonts for the popup (OFL)
tests/
  run-tests.js         Node unit tests
  test-page.html       local page with every kind of maths
scripts/
  package.mjs          builds dist/mathsclip-v<version>.zip
  subset-fonts.py      rebuilds src/fonts from the full CMU fonts
  render-icons.py      renders the icon PNGs from icon.svg
.github/               CI workflow, issue forms, README screenshot
```

## Ideas for later

- Copy an equation as a PNG or SVG image
- Copy as MathML, for editable equations in Word
- Typst output
- Turning MathML back into LaTeX, for pages that have no TeX annotation
