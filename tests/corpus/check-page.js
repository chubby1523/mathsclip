/**
 * Runs inside a real page (injected by run.mjs after src/defaults.js, extractors.js, serializer.js
 * and main-world.js). Selects the article, copies it twice — the browser's own way and MathsClip's
 * way — and reports where MathsClip's copy is worse than the browser's, plus maths that looks wrong.
 * Evaluated as a function expression: (checkPage)(rootSelector).
 */
(async function checkPage(rootSelector) {
  const ROOTS = [rootSelector, "#mw-content-text .mw-parser-output", "#mainbar", ".ltx_page_main", "main", "article", "#content", "body"];
  const root = ROOTS.filter(Boolean).map((s) => document.querySelector(s)).find(Boolean);
  const { extractors, serializer } = window.CopyMath;

  // Let the main-world bridge stamp MathJax TeX, as a real Ctrl+C does.
  extractors.requestMainWorldSync();
  await new Promise((r) => setTimeout(r, 300));

  const sel = window.getSelection();
  sel.removeAllRanges();
  const range = document.createRange();
  range.selectNodeContents(root);
  sel.addRange(range);
  const native = sel.toString();
  const ours = serializer.serializeSelection(sel, { selectionFormat: "plain", delimiters: "dollar" }, { skipSync: true });
  sel.removeAllRanges();

  const MATH = /\$\$[\s\S]*?\$\$|\$[^$\n]+\$/g;
  const prose = ours.replace(MATH, " ");
  const tex = (ours.match(MATH) || []).map((m) => m.replace(/^\$\$?|\$\$?$/g, "").trim());
  const context = (text, needle) => {
    const i = text.indexOf(needle);
    return i < 0 ? "" : text.slice(Math.max(0, i - 50), i + needle.length + 50).replace(/\s+/g, " ");
  };
  const countWords = (text) => {
    const counts = new Map();
    for (const w of text.match(/[\p{L}\p{N}][\p{L}\p{N}'’]*/gu) || []) counts.set(w, (counts.get(w) || 0) + 1);
    return counts;
  };

  // Count occurrences as substrings, not words: the browser's copy often runs inline list items
  // together ("chargeCharge"), which would otherwise look like words MathsClip added.
  const occurrences = (text, w) => text.split(w).length - 1;
  // Words in MathsClip's prose that the browser's copy doesn't have: junk MathsClip added.
  const extra = [...countWords(prose)]
    .map(([w, n]) => ({ word: w, excess: n - occurrences(native, w), context: context(prose, w) }))
    .filter((x) => x.excess > 0);
  // Real words the browser copies that MathsClip loses entirely.
  const missing = [...countWords(native)]
    .filter(([w]) => w.length >= 4 && /^\p{L}+$/u.test(w) && !ours.includes(w))
    .map(([w, n]) => ({ word: w, count: n, context: context(native, w) }));

  const balanced = (t) => {
    let depth = 0;
    for (const ch of t.replace(/\\[{}]/g, "")) {
      if (ch === "{") depth++;
      if (ch === "}" && --depth < 0) return false;
    }
    return depth === 0;
  };
  const badTex = tex
    .filter((t) => !t || !balanced(t) || /^\{\\displaystyle/.test(t))
    .map((t) => t.slice(0, 160));
  const unicodeInTex = tex.filter((t) => /[^\x00-\x7f]/.test(t)).map((t) => t.slice(0, 160));

  // Match in the prose, but show the surrounding text from the real copy (maths included).
  const snippets = (re) => [...new Set([...prose.matchAll(re)].map((m) => m[0]))].slice(0, 15).map((s) => context(ours, s));
  const mathCharsOutside = snippets(/[∇∑∏∫∮∯≤≥≠≈±∓×⋅∂∞∈∉⊂⊆∪∩→↦⇒⇔√αβγδεζηθκλμνξπρστφχψωΓΔΘΛΞΠΣΦΨΩ]/g);
  const leakedTex = snippets(/\\[a-zA-Z]{2,}/g);

  const texhtml = [...root.querySelectorAll(".texhtml")].filter((el) => !el.parentElement.closest(".texhtml"));
  const unconverted = texhtml
    .filter((el) => extractors.findMathRoot(el) !== el)
    .slice(0, 15)
    .map((el) => el.innerHTML.replace(/ (about|id|data-mw|typeof)="[^"]*"/g, "").slice(0, 200));

  // Maths elements MathsClip finds but can't read: these vanish from the copy.
  const short = (el) => el.outerHTML.replace(/ (about|id|typeof)="[^"]*"/g, "").slice(0, 220);
  const roots = new Set([...root.querySelectorAll(extractors.MATH_ROOT_SELECTOR)].map((el) => extractors.findMathRoot(el)).filter(Boolean));
  const unreadable = [...roots].filter((el) => !extractors.extractMath(el));

  return {
    title: document.title,
    root: root.id || root.className || root.tagName,
    unreadable: unreadable.length,
    unreadableExamples: unreadable.slice(0, 5).map((el) => `${el.previousElementSibling ? short(el.previousElementSibling) + " ⟶ " : ""}${short(el)}`),
    nativeLength: native.length,
    oursLength: ours.length,
    equations: tex.length,
    texhtml: texhtml.length,
    extra,
    missing,
    badTex,
    unicodeInTex: unicodeInTex.slice(0, 15),
    mathCharsOutside,
    leakedTex,
    unconverted,
  };
});
