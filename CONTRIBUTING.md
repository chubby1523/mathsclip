# Contributing

Thanks for helping out with MathsClip.

## Reporting a problem

If maths doesn't copy, or copies as the wrong LaTeX, [open an issue](https://github.com/chubby1523/mathsclip/issues/new/choose). The form asks for:

- the page's URL
- how you copied (Ctrl+C, right-click or Click-to-Copy)
- what ended up on your clipboard, and what you expected
- your Chrome and MathsClip versions

The page URL matters most. Every site renders maths a little differently, so most bugs only show up on a specific page.

Feature ideas are welcome too. Use the feature request form.

## Running it locally

1. Clone the repository.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and choose the folder.

After editing, click the reload button on the extension's card and refresh the page you're testing.

`tests/test-page.html` has examples of each kind of maths the extension supports. To use it as a local file, turn on **Allow access to file URLs** on the extension's details page.

There's no build step and no npm install. The extension is plain JavaScript, and the tests only need Node.js 20 or later.

## Before opening a pull request

Run the checks:

```bash
node --check src/defaults.js src/main-world.js src/extractors.js src/serializer.js src/background.js src/content.js src/popup/popup.js
node --test tests/run-tests.js
```

GitHub Actions runs the same checks on every push and pull request.

Keep each pull request to one change, and say which pages you tested it on. If you fix a site, a test in `tests/run-tests.js` with a cut-down copy of that page's HTML stops it breaking again.

### Checking real pages in bulk

The unit tests use a fake DOM, which can't catch everything a real browser does (CSS escaping, MathJax rendering late). To check many real pages at once:

```bash
node tests/corpus/run.mjs                 # every page in tests/corpus/pages.txt
node tests/corpus/run.mjs --only Gauss    # just the URLs containing "Gauss"
```

It opens each page in headless Chrome (or Edge), runs MathsClip's code on the whole article, and compares the result with the browser's own copy. The report in `dist/corpus/report.md` lists words MathsClip adds or drops, equations it can't read, and TeX that looks broken. It needs network access, takes about 5 minutes for the full list, and isn't part of CI.

[ARCHITECTURE.md](ARCHITECTURE.md) explains how the pieces fit together.

## Versions

Versions follow `MAJOR.MINOR.PATCH` and live in `manifest.json`:

- **Patch** (1.0.1): bug fixes and site fixes
- **Minor** (1.1.0): new features
- **Major** (2.0.0): big changes to how it works or to its settings

The Chrome Web Store won't accept an upload unless the version is higher than the one already published.

## Releasing

1. Bump `"version"` in `manifest.json`.
2. Run the checks above, then try it in Chrome on a few real pages.
3. Build the ZIP with `node scripts/package.mjs`. This creates `dist/mathsclip-v<version>.zip`, which holds only `manifest.json`, `icons/` and `src/`.
4. Commit, then tag the release and push the tag:
   ```bash
   git tag v<version>
   git push origin v<version>
   ```
5. Create a GitHub release from the tag, with a short list of changes, and attach the ZIP.
6. Upload the same ZIP to the Chrome Web Store.
