/**
 * Bulk check: copies whole articles from real pages, the browser's way and MathsClip's way,
 * and reports where MathsClip's copy is worse. Needs Chrome (or Edge) and network access;
 * no npm packages. Not part of CI.
 *
 *   node tests/corpus/run.mjs [pages.txt] [--only <substring>]
 *
 * Writes dist/corpus/report.md and dist/corpus/report.json.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const args = process.argv.slice(2);
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : "";
const listFile = args.find((a) => a.endsWith(".txt")) || path.join(HERE, "pages.txt");
// --eval <file.js>: run that expression on each page instead of the checker and print the result (for debugging).
const evalFile = args.includes("--eval") ? args[args.indexOf("--eval") + 1] : "";

const pages = fs
  .readFileSync(listFile, "utf8")
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith("#"))
  .map((l) => {
    const [url, selector = ""] = l.split(/\s+/);
    return { url, selector };
  })
  .filter((p) => p.url.includes(only));

// The same files, in the same order, as the extension's content scripts (minus content.js, which needs chrome.*).
const injected = ["src/main-world.js", "src/defaults.js", "src/extractors.js", "src/serializer.js"]
  .map((f) => fs.readFileSync(path.join(ROOT, f), "utf8"))
  .join("\n;\n");
const checker = fs.readFileSync(path.join(HERE, "check-page.js"), "utf8").replace(/^\/\*\*[\s\S]*?\*\/\s*/, "").replace(/;\s*$/, "");

const BROWSERS = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter(Boolean);
const browserPath = BROWSERS.find((p) => fs.existsSync(p));
if (!browserPath) throw new Error("No Chrome/Edge found; set CHROME_PATH");

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "mathsclip-corpus-"));
const browser = spawn(browserPath, [
  "--headless=new",
  "--remote-debugging-port=0",
  `--user-data-dir=${profile}`,
  "--no-first-run",
  "--no-default-browser-check",
  "--window-size=1280,2000",
  "about:blank",
]);

const portFile = path.join(profile, "DevToolsActivePort");
for (let i = 0; !fs.existsSync(portFile); i++) {
  if (i > 100) throw new Error("Browser didn't start");
  await new Promise((r) => setTimeout(r, 100));
}
await new Promise((r) => setTimeout(r, 100));
const [port, wsPath] = fs.readFileSync(portFile, "utf8").trim().split("\n");

// Minimal DevTools protocol client.
const ws = new WebSocket(`ws://127.0.0.1:${port}${wsPath}`);
await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
let nextId = 1;
const pending = new Map();
const listeners = new Set();
ws.onmessage = ({ data }) => {
  const msg = JSON.parse(data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
  } else for (const fn of listeners) fn(msg);
};
// Every call has a time limit, so one stuck page fails on its own instead of hanging the whole run.
const send = (method, params = {}, sessionId, ms = 45000) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out after ${ms / 1000}s`));
    }, ms);
    const settle = (fn) => (v) => (clearTimeout(timer), fn(v));
    pending.set(id, { resolve: settle(resolve), reject: settle(reject) });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
const waitFor = (method, sessionId, ms) =>
  new Promise((resolve) => {
    const done = (v) => (listeners.delete(fn), clearTimeout(timer), resolve(v));
    const fn = (msg) => msg.method === method && msg.sessionId === sessionId && done(true);
    const timer = setTimeout(() => done(false), ms);
    listeners.add(fn);
  });

const results = [];
for (const { url, selector } of pages) {
  process.stdout.write(`${url} … `);
  // A fresh tab per page, so a page that wedges its tab can't affect the next one.
  let targetId;
  try {
    ({ targetId } = await send("Target.createTarget", { url: "about:blank" }));
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    await send("Page.enable", {}, sessionId);
    await send("Page.setBypassCSP", { enabled: true }, sessionId);
    // Leave any alert/confirm/beforeunload dialog a page opens, rather than wait on it forever.
    listeners.add((msg) => {
      if (msg.method === "Page.javascriptDialogOpening" && msg.sessionId === sessionId)
        send("Page.handleJavaScriptDialog", { accept: true }, sessionId).catch(() => {});
    });
    const evaluate = async (expression) => {
      const res = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
      if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
      return res.result.value;
    };

    const loaded = waitFor("Page.loadEventFired", sessionId, 30000);
    await send("Page.navigate", { url }, sessionId);
    await loaded;
    // Wait for MathJax/KaTeX to finish typesetting: until the count of rendered maths holds steady
    // for 1.5s (up to 15s). Checking mid-typeset made equations look unreadable.
    await evaluate(`new Promise((done) => {
      const start = Date.now();
      let last = -1, steadySince = Date.now();
      const tick = () => {
        const n = document.querySelectorAll("mjx-container, .MathJax, .katex, [data-cm-tex]").length;
        if (n !== last) (last = n), (steadySince = Date.now());
        if (Date.now() - steadySince > 1500 || Date.now() - start > 15000) done();
        else setTimeout(tick, 250);
      };
      tick();
    })`);
    await evaluate(injected);
    if (evalFile) {
      console.log(JSON.stringify(await evaluate(fs.readFileSync(evalFile, "utf8")), null, 1));
      continue;
    }
    const report = await evaluate(`(${checker})(${JSON.stringify(selector)})`);
    results.push({ url, ...report });
    console.log(`"${report.title}": ${report.equations} equations, ${report.extra.length} extra, ${report.missing.length} missing`);
    // Be gentle: back-to-back loads get rate-limited (Wikipedia served error pages without this).
    await new Promise((r) => setTimeout(r, 1500));
  } catch (err) {
    results.push({ url, error: String(err.message || err) });
    console.log(`ERROR ${err.message || err}`);
  } finally {
    if (targetId) await send("Target.closeTarget", { targetId }, undefined, 10000).catch(() => {});
  }
}

ws.close();
const exited = new Promise((r) => browser.once("exit", r));
browser.kill();
await exited;

// Chrome's helper processes can hold the profile a moment longer; retry rather than fail the run.
fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
if (evalFile) process.exit(0); // debugging run: leave the last report alone

// Group findings across pages so systematic problems float to the top.
const ok = results.filter((r) => !r.error);
const grouped = (key, field) => {
  const map = new Map();
  for (const r of ok)
    for (const item of r[key]) {
      const k = item[field];
      if (!map.has(k)) map.set(k, { [field]: k, pages: 0, total: 0, example: item.context });
      const g = map.get(k);
      g.pages++;
      g.total += item.excess || item.count || 1;
    }
  return [...map.values()].sort((a, b) => b.pages - a.pages || b.total - a.total);
};
const extra = grouped("extra", "word");
const missing = grouped("missing", "word");

const lines = [
  `# MathsClip corpus check`,
  ``,
  `${ok.length} pages checked, ${results.length - ok.length} failed to load.`,
  ``,
  `## Pages`,
  ``,
  `| Page | Equations | texhtml (unconverted) | Extra words | Missing words | Bad TeX | Maths chars outside $ | Leaked \\commands |`,
  `|---|---|---|---|---|---|---|---|`,
  ...results.map((r) =>
    r.error
      ? `| ${r.url} | error: ${r.error.slice(0, 80)} |||||||`
      : `| ${r.url}${r.equations ? "" : ` ("${r.title}", root ${r.root})`} | ${r.equations} | ${r.texhtml} (${r.unconverted.length}) | ${r.extra.length} | ${r.missing.length} | ${r.badTex.length} | ${r.mathCharsOutside.length} | ${r.leakedTex.length} |`
  ),
  ``,
  `## Words MathsClip adds (not in the browser's copy), by number of pages`,
  ``,
  ...extra.slice(0, 40).map((g) => `- **${g.word}** — ${g.pages} pages, ${g.total}×. e.g. \`${g.example}\``),
  ``,
  `## Words MathsClip drops (in the browser's copy only), by number of pages`,
  ``,
  ...missing.slice(0, 40).map((g) => `- **${g.word}** — ${g.pages} pages, ${g.total}×. e.g. \`${g.example}\``),
  ``,
  `## Per-page maths findings`,
  ``,
  ...ok.flatMap((r) => {
    const parts = [
      ["Bad TeX", r.badTex],
      ["Non-ASCII inside TeX", r.unicodeInTex],
      ["Maths characters outside $…$", r.mathCharsOutside],
      ["Leaked \\commands outside $…$", r.leakedTex],
      ["Unconverted texhtml", r.unconverted],
    ].filter(([, list]) => list.length);
    return parts.length
      ? [`### ${r.url}`, ``, ...parts.flatMap(([title, list]) => [`${title}:`, ...list.slice(0, 8).map((x) => `- \`${x}\``), ``])]
      : [];
  }),
];

const outDir = path.join(ROOT, "dist", "corpus");
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "report.md"), lines.join("\n"));
fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify(results, null, 1));
console.log(`\nReport: ${path.join(outDir, "report.md")}`);
