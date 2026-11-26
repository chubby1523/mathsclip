/**
 * Unified math DOM detection and LaTeX extraction across:
 * - KaTeX (.katex-display, .katex)
 * - MathJax v3/v4 (mjx-container + main-world stamps + assistive MathML fallback)
 * - MathJax v2 (.MathJax_Display, .MJXc-display, .MathJax, .mjx-chtml + <script type="math/tex">)
 * - Wikipedia / Wikiwand math images (.mwe-math-element, img.mwe-math-fallback-image-*)
 * - Standalone MathML (<math> with TeX <annotation> or alttext)
 */
(function initExtractors(root) {
  const CopyMath = (root.CopyMath = root.CopyMath || {});
  const SYNC_EVENT = "copy-math:sync";

  // One list per renderer; every check below is built from these.
  const KATEX_CLASSES = ["katex-display", "katex"];
  const MATHJAX2_CLASSES = ["MathJax_Display", "MJXc-display", "MathJax", "mjx-chtml"];
  const WIKI_CLASSES = [
    "mwe-math-element",
    "mwe-math-fallback-image-inline",
    "mwe-math-fallback-image-display",
    "mwe-math-fallback-image-block",
  ];
  const toSelector = (classes) => classes.map((c) => `.${c}`);
  // Matched in code, not a selector: in CSS, img[alt="\oiint"] would read the backslash as an escape.
  const WIKI_INTEGRALS = new Set(["\\oint", "\\oiint", "\\oiiint"]);

  const MATH_ROOT_SELECTOR = [
    ...toSelector(KATEX_CLASSES),
    "mjx-container",
    ...toSelector(MATHJAX2_CLASSES),
    ...toSelector(WIKI_CLASSES),
    "img.latex",
    'img[src*="latex.codecogs.com"]',
    'img[src*="latex.php"]',
    "[data-latex]",
    "[data-tex]",
    "[data-math]",
    "[data-xpm-copy-root]",
    "math",
    ".texhtml",
    "span.nowrap", // only Wikipedia integral templates count; others are climbed past
  ].join(",");

  const WIKI_IMAGE_SELECTOR =
    "img.mwe-math-fallback-image-inline, img.mwe-math-fallback-image-display, img.mwe-math-fallback-image-block, img[data-mathml]";

  const INLINE_TAGS = new Set([
    "span", "a", "b", "i", "em", "strong", "small", "sub", "sup", "code", "mark", "u", "s", "q", "cite", "abbr", "label",
  ]);

  const BOOLEAN_FLAG_VALUES = new Set(["", "true", "false", "inline", "display", "block"]);

  function requestMainWorldSync() {
    if (typeof document !== "undefined" && typeof CustomEvent === "function") {
      document.dispatchEvent(new CustomEvent(SYNC_EVENT));
    }
  }

  /**
   * Strips MediaWiki/Wikipedia display wrappers like `{\displaystyle x^2}` -> `x^2`.
   * @param {string} raw
   * @returns {string}
   */
  function cleanWikiTex(raw) {
    let text = String(raw || "").trim();
    if (!text) return "";
    const wrappedMatch = text.match(
      /^\{\s*\\(?:displaystyle|textstyle|scriptstyle|scriptscriptstyle)\s+([\s\S]*)\}$/
    );
    if (wrappedMatch) {
      text = wrappedMatch[1].trim();
    }
    return text.replace(/^\\(?:displaystyle|textstyle)\s+/, "").trim();
  }

  function toElement(node) {
    if (!node) return null;
    return node.nodeType === 1 ? node : node.parentElement || null;
  }

  // Container that can hold several math roots (used to climb to the outermost one).
  const CONTAINER_SELECTOR = [
    "mjx-container",
    ...toSelector([...KATEX_CLASSES, ...MATHJAX2_CLASSES, "mwe-math-element"]),
  ].join(", ");

  const tagOf = (el) => (el.tagName ? el.tagName.toLowerCase() : "");
  const hasAnyClass = (el, classes) => classes.some((c) => el.classList?.contains(c));

  function isWikiMath(el) {
    return hasAnyClass(el, WIKI_CLASSES) || (tagOf(el) === "img" && Boolean(el.hasAttribute?.("data-mathml")));
  }

  function isLegacyImage(el) {
    if (tagOf(el) !== "img") return false;
    const src = el.getAttribute?.("src") || "";
    return (
      Boolean(el.classList?.contains("latex")) ||
      src.includes("latex.codecogs.com") ||
      src.includes("latex.php")
    );
  }

  function isKnownMathContainer(el) {
    return (
      isMathJaxRoot(el) || hasAnyClass(el, KATEX_CLASSES) || isWikiMath(el) || isLegacyImage(el)
    );
  }

  /**
   * Finds the outermost valid math root element for `node` (ignoring nested wrappers
   * like `.katex` inside `.katex-display` or `<math>` inside `.katex` / `mjx-container`,
   * and skipping false-positive `[data-math="true"]` containers or bare `<math>` without TeX).
   */
  function findMathRoot(node) {
    let cur = toElement(node);
    while (cur && typeof cur.closest === "function") {
      const candidate = cur.closest(MATH_ROOT_SELECTOR);
      if (!candidate) return null;

      // Climb to outermost display math or MathJax container first.
      const outerContainer =
        candidate.closest(".katex-display, .MathJax_Display, .MJXc-display") ||
        candidate.closest("mjx-container");
      if (outerContainer) return outerContainer;

      const outerGoogle = candidate.closest("[data-xpm-copy-root]");
      if (outerGoogle) return outerGoogle;

      // The pieces of a Wikipedia integral template belong to the whole equation.
      const outerIntegral = candidate.closest("span.nowrap");
      if (outerIntegral && extractWikiIntegral(outerIntegral)) return outerIntegral;

      const outerWiki = candidate.closest(".mwe-math-element");
      if (outerWiki) {
        if (outerWiki.tagName?.toLowerCase() === "g") {
          cur = outerWiki.parentElement;
          continue;
        }
        return outerWiki;
      }

      const parentContainer = candidate.parentElement?.closest(CONTAINER_SELECTOR);
      if (parentContainer) return findMathRoot(parentContainer);

      const tag = candidate.tagName ? candidate.tagName.toLowerCase() : "";
      if (
        tag === "math" &&
        !readTexAnnotation(candidate) &&
        !candidate.getAttribute("alttext")?.trim() &&
        !readDataMwMath(candidate)
      ) {
        cur = candidate.parentElement;
        continue;
      }

      if (
        tag !== "math" &&
        !isKnownMathContainer(candidate) &&
        !extractDataAttributeMath(candidate) &&
        !extractTexHtml(candidate)
      ) {
        cur = candidate.parentElement;
        continue;
      }

      return candidate;
    }
    return null;
  }

  function readTexAnnotation(scopeEl) {
    if (!scopeEl || typeof scopeEl.querySelector !== "function") return "";
    const annotation =
      scopeEl.querySelector('annotation[encoding="application/x-tex"]') ||
      scopeEl.querySelector('annotation[encoding="application/x-latex"]') ||
      // Skip text/plain: that's spoken text ("x equals ..."), e.g. Google's overlay MathML.
      Array.from(scopeEl.querySelectorAll("annotation")).find(
        (a) => !(a.getAttribute("encoding") || "").startsWith("text/plain")
      );
    return annotation?.textContent ? annotation.textContent.trim() : "";
  }

  function readDataMwMath(scopeEl) {
    if (!scopeEl) return null;
    let target = scopeEl.hasAttribute?.("data-mw")
      ? scopeEl
      : scopeEl.querySelector?.("[data-mw]");
    if (!target) {
      // Wikidata-linked equations (<math qid=…>): the TeX sits on another element sharing the
      // same Parsoid `about` id. Look it up in the page, which also works for a copied fragment.
      const about = scopeEl.getAttribute?.("about") || scopeEl.querySelector?.("[about]")?.getAttribute("about");
      if (about && /^#mwt\d+$/.test(about)) {
        target = scopeEl.ownerDocument?.querySelector?.(`[about="${about}"][data-mw]`);
      }
    }
    const rawJson = target?.getAttribute?.("data-mw");
    if (!rawJson) return null;
    try {
      const parsed = JSON.parse(rawJson);
      if (parsed?.name !== "math" || typeof parsed?.body?.extsrc !== "string") {
        return null;
      }
      const tex = cleanWikiTex(parsed.body.extsrc);
      if (!tex) return null;
      return {
        tex,
        displayMode:
          parsed?.attrs?.display === "block" ||
          target.getAttribute?.("display") === "block" ||
          Boolean(target.classList?.contains("mwe-math-element-block")),
      };
    } catch {
      return null;
    }
  }

  // Wikipedia's {{oint}} / {{oiint}} / {{oiiint}}: a <span class="nowrap"> holding an image of the
  // integral sign (alt="\oiint") between separate <math> pieces, the subscript in a shifted span.
  // Read the pieces in page order. (data-mw has the template call too, but not when it's nested in another template.)
  function extractWikiIntegral(box) {
    const images = Array.from(box.querySelectorAll?.("img") || []);
    if (tagOf(box) !== "span" || !images.some((img) => WIKI_INTEGRALS.has(img.getAttribute("alt")))) return null;
    const pieces = [];
    const walk = (node) => {
      if (node.nodeType === 3) {
        if (node.textContent.trim()) throw new Error("text between the pieces");
        return;
      }
      if (node.nodeType !== 1 || tagOf(node) === "mjx-container") return;
      if (tagOf(node) === "img") {
        if (!WIKI_INTEGRALS.has(node.getAttribute("alt"))) throw new Error("other image");
        pieces.push(node.getAttribute("alt"));
        return;
      }
      if (tagOf(node) === "math") {
        const tex = cleanWikiTex(extractStandaloneMathML(node)?.tex || "").replace(/^\\(?:scriptstyle|textstyle)\s*/, "");
        if (!tex) throw new Error("piece without TeX");
        const shifted = node.closest('span[style*="top:"]');
        pieces.push(shifted && !/^[_^]/.test(tex) ? `_{${tex}}` : tex);
        return;
      }
      Array.from(node.childNodes || []).forEach(walk);
    };
    try {
      Array.from(box.childNodes || []).forEach(walk);
    } catch {
      return null;
    }
    const tex = pieces.reduce((out, p) => (/^[_^]/.test(p) ? out + p : out ? `${out} ${p}` : p), "");
    return { tex, displayMode: Boolean(box.closest?.("dd")) };
  }

  function extractKatex(rootEl) {
    const tex = readTexAnnotation(rootEl);
    if (!tex) return null;
    const mathEl = rootEl.querySelector("math");
    const displayMode =
      rootEl.classList.contains("katex-display") ||
      Boolean(rootEl.closest(".katex-display")) ||
      mathEl?.getAttribute("display") === "block";
    return { tex, displayMode };
  }

  function extractMathJaxV3(rootEl) {
    const isDisplayAttr =
      rootEl.getAttribute("display") === "block" ||
      rootEl.getAttribute("display") === "true";

    const stampedTex = rootEl.getAttribute("data-cm-tex");
    if (stampedTex && stampedTex.trim()) {
      const stampedDisplay = rootEl.getAttribute("data-cm-display");
      const displayMode = stampedDisplay === "true" || isDisplayAttr;
      return { tex: stampedTex.trim(), displayMode };
    }

    const assistiveTex = readTexAnnotation(rootEl);
    if (assistiveTex) {
      const mathEl = rootEl.querySelector("math");
      const displayMode =
        isDisplayAttr || mathEl?.getAttribute("display") === "block";
      return { tex: assistiveTex, displayMode };
    }

    const attrTex =
      rootEl.getAttribute("data-latex") ||
      rootEl.getAttribute("data-tex") ||
      rootEl.querySelector("math[alttext]")?.getAttribute("alttext");
    if (attrTex && attrTex.trim()) {
      return {
        tex: attrTex.trim(),
        displayMode: isDisplayAttr,
      };
    }

    // Skip unscrolled MathJax lazy placeholder containers so the visible sibling <math> handles extraction once.
    // (A sibling hidden in .mwe-math-mathml-a11y isn't copied, so then the container must answer for it.)
    const prev = rootEl.previousElementSibling;
    if (
      rootEl.querySelector?.("mjx-lazy") &&
      !rootEl.querySelector?.("svg, mjx-math") &&
      !rootEl.getAttribute("data-cm-tex") &&
      !prev?.classList?.contains("mwe-math-mathml-a11y")
    ) {
      return null;
    }

    // Fallback for Wikipedia 2026 MathJax SVG: hidden sibling <span><math>...</math></span> right before <mjx-container>
    if (prev && (prev.tagName?.toLowerCase() === "math" || prev.querySelector?.("math, .mwe-math-element"))) {
      const mw = readDataMwMath(prev);
      if (mw) {
        return {
          tex: mw.tex,
          displayMode: isDisplayAttr || mw.displayMode,
        };
      }
      const siblingRaw =
        readTexAnnotation(prev) ||
        prev.querySelector?.("math[alttext]")?.getAttribute("alttext") ||
        prev.getAttribute?.("alttext") ||
        "";
      const cleaned = cleanWikiTex(siblingRaw);
      if (cleaned) {
        return {
          tex: cleaned,
          displayMode:
            isDisplayAttr ||
            Boolean(prev.querySelector?.('math[display="block"]')) ||
            prev.getAttribute?.("display") === "block",
        };
      }
    }

    return null;
  }

  function findMathJaxV2Script(rootEl) {
    const frameId = rootEl.id;
    if (frameId && frameId.endsWith("-Frame")) {
      const scriptId = frameId.slice(0, -"-Frame".length);
      const byId = rootEl.ownerDocument?.getElementById(scriptId);
      if (byId && byId.tagName?.toLowerCase() === "script") return byId;
    }

    // Child inside .MathJax_Display / .MJXc-display
    const nested = rootEl.querySelector('script[type*="math/tex"]');
    if (nested) return nested;

    // Scan forward across following siblings, skipping non-math elements (e.g. .MathJax_Preview)
    // and stopping immediately if we hit the next rendered MathJax equation.
    let sib = rootEl.nextElementSibling;
    while (sib) {
      const tag = sib.tagName?.toLowerCase();
      const type = sib.type || sib.getAttribute?.("type") || "";
      if (tag === "script" && type.includes("math/tex")) {
        return sib;
      }
      if (
        sib.classList?.contains("MathJax") ||
        sib.classList?.contains("mjx-chtml") ||
        sib.classList?.contains("MathJax_Display") ||
        sib.classList?.contains("MJXc-display")
      ) {
        break;
      }
      sib = sib.nextElementSibling;
    }
    return null;
  }

  function extractMathJaxV2(rootEl) {
    const stampedTex =
      rootEl.getAttribute("data-cm-tex") ||
      rootEl.querySelector("[data-cm-tex]")?.getAttribute("data-cm-tex");
    if (stampedTex && stampedTex.trim()) {
      const stampedDisplay =
        rootEl.getAttribute("data-cm-display") ||
        rootEl.querySelector("[data-cm-display]")?.getAttribute("data-cm-display");
      const displayMode =
        stampedDisplay === "true" ||
        rootEl.classList.contains("MathJax_Display") ||
        rootEl.classList.contains("MJXc-display");
      return { tex: stampedTex.trim(), displayMode };
    }

    const scriptEl = findMathJaxV2Script(rootEl);
    if (scriptEl && scriptEl.textContent?.trim()) {
      const displayMode =
        Boolean(scriptEl.type?.includes("mode=display")) ||
        rootEl.classList.contains("MathJax_Display") ||
        rootEl.classList.contains("MJXc-display");
      return { tex: scriptEl.textContent.trim(), displayMode };
    }

    return extractMathJaxV3(rootEl);
  }

  function extractWikiMath(rootEl) {
    const mw = readDataMwMath(rootEl);
    if (mw) return mw;

    const annotationTex = readTexAnnotation(rootEl);
    const imgEl =
      rootEl.tagName?.toLowerCase() === "img"
        ? rootEl
        : rootEl.querySelector(WIKI_IMAGE_SELECTOR) || rootEl.querySelector("img");

    const rawTex = annotationTex || imgEl?.getAttribute("alt") || "";
    const tex = cleanWikiTex(rawTex);
    if (!tex) return null;

    const displayMode = Boolean(
      imgEl?.classList?.contains("mwe-math-fallback-image-display") ||
        imgEl?.classList?.contains("mwe-math-fallback-image-block") ||
        rootEl.classList?.contains("mwe-math-fallback-image-display") ||
        rootEl.classList?.contains("mwe-math-fallback-image-block") ||
        rootEl.classList?.contains("mwe-math-element-block") ||
        rootEl.querySelector('math[display="block"]') ||
        (rootEl.closest && rootEl.closest("dl > dd") && !rootEl.previousSibling?.textContent?.trim())
    );
    return { tex, displayMode };
  }

  // Wikipedia's {{math}} / {{mvar}} templates: HTML maths (<i>ε</i><sub>0</sub>) with no TeX source.
  const TEXHTML_SYMBOLS = {
    α: "\\alpha", β: "\\beta", γ: "\\gamma", δ: "\\delta", ε: "\\varepsilon", ϵ: "\\epsilon",
    ζ: "\\zeta", η: "\\eta", θ: "\\theta", ϑ: "\\vartheta", ι: "\\iota", κ: "\\kappa",
    λ: "\\lambda", μ: "\\mu", ν: "\\nu", ξ: "\\xi", ο: "o", π: "\\pi", ρ: "\\rho", ϱ: "\\varrho",
    σ: "\\sigma", ς: "\\varsigma", τ: "\\tau", υ: "\\upsilon", φ: "\\varphi", ϕ: "\\phi",
    χ: "\\chi", ψ: "\\psi", ω: "\\omega",
    Γ: "\\Gamma", Δ: "\\Delta", Θ: "\\Theta", Λ: "\\Lambda", Ξ: "\\Xi", Π: "\\Pi", Σ: "\\Sigma",
    Υ: "\\Upsilon", Φ: "\\Phi", Ψ: "\\Psi", Ω: "\\Omega",
    "−": "-", "–": "-", "×": "\\times", "⋅": "\\cdot", "·": "\\cdot", "∗": "*", "÷": "\\div",
    "±": "\\pm", "∓": "\\mp", "⁄": "/", "∕": "/",
    "≤": "\\le", "≥": "\\ge", "≠": "\\neq", "≈": "\\approx", "≡": "\\equiv", "∼": "\\sim",
    "≃": "\\simeq", "≅": "\\cong", "∝": "\\propto", "≪": "\\ll", "≫": "\\gg",
    "∈": "\\in", "∉": "\\notin", "∋": "\\ni", "⊂": "\\subset", "⊆": "\\subseteq",
    "⊃": "\\supset", "⊇": "\\supseteq", "∪": "\\cup", "∩": "\\cap", "∅": "\\emptyset",
    "∖": "\\setminus", "∀": "\\forall", "∃": "\\exists", "¬": "\\neg", "∧": "\\land", "∨": "\\lor",
    "→": "\\to", "←": "\\leftarrow", "↦": "\\mapsto", "⇒": "\\Rightarrow", "⇔": "\\Leftrightarrow",
    "↔": "\\leftrightarrow",
    "∇": "\\nabla", "∂": "\\partial", "∞": "\\infty", "∑": "\\sum", "∏": "\\prod", "∫": "\\int",
    "∮": "\\oint", "√": "\\surd", "∘": "\\circ", "⊗": "\\otimes", "⊕": "\\oplus", "†": "\\dagger",
    "⊥": "\\perp", "∥": "\\parallel", "∣": "\\mid", "‖": "\\|", "∠": "\\angle", "°": "^\\circ",
    "⌊": "\\lfloor", "⌋": "\\rfloor", "⌈": "\\lceil", "⌉": "\\rceil", "◻": "\\Box", "□": "\\Box",
    ƒ: "f", "′": "'", "″": "''", "‴": "'''", "⟨": "\\langle", "⟩": "\\rangle", "…": "\\ldots", "⋯": "\\cdots",
    ℏ: "\\hbar", ℓ: "\\ell", ℵ: "\\aleph", "ℂ": "\\mathbb{C}", "ℝ": "\\mathbb{R}", "ℕ": "\\mathbb{N}",
    "ℤ": "\\mathbb{Z}", "ℚ": "\\mathbb{Q}",
    "{": "\\{", "}": "\\}", "%": "\\%", "#": "\\#", "&": "\\&", "$": "\\$", _: "\\_", "\\": "\\backslash",
    "~": "\\sim", "^": "\\hat{}",
  };
  const TEXHTML_OPERATORS = new Set([
    "sin", "cos", "tan", "cot", "sec", "csc", "sinh", "cosh", "tanh", "arcsin", "arccos", "arctan",
    "log", "ln", "lg", "exp", "det", "dim", "ker", "deg", "gcd", "lim", "max", "min", "sup", "inf",
    "arg", "Pr",
  ]);
  const TEXHTML_ACCENTS = {
    "\u0302": "\\hat", "\u0303": "\\tilde", "\u0304": "\\bar", "\u0305": "\\bar",
    "\u0307": "\\dot", "\u0308": "\\ddot", "\u20d7": "\\vec",
  };
  // Marks the end of a \command; becomes a space only where a letter follows.
  const CMD_END = "\u0001";
  const TEXHTML_SPACE = /[\s\u00a0\u2009\u200a\u200b\u200d\u202f\u2060]/;
  const TEXHTML_SKIP_TAGS = new Set(["style", "link", "script"]);

  // Returns TeX, or throws on anything it can't map so the span stays plain text instead of half-converted.
  function texHtmlToTex(node, italic) {
    if (node.nodeType === 3) {
      let out = "";
      // Lone upright letters are almost always variables missing their '' italics, so they stay bare.
      const letters = (word) =>
        italic || word.length < 2
          ? word
          : TEXHTML_OPERATORS.has(word) ? `\\${word}${CMD_END}`
          : word === "Re" || word === "Im" ? `\\operatorname{${word}}` : `\\mathrm{${word}}`;
      // Split ŷ into y + U+0302 so accents are handled in one place (but leave ≠ alone).
      const text = (node.textContent || "").replace(/[À-ɏ]/g, (c) => c.normalize("NFD"));
      for (let i = 0; i < text.length; ) {
        const ch = text[i];
        if (/[A-Za-z]/.test(ch)) {
          const word = text.slice(i).match(/^[A-Za-z]+/)[0];
          i += word.length;
          const accent = TEXHTML_ACCENTS[text[i]];
          if (accent) {
            i++;
            out += `${letters(word.slice(0, -1))}${accent}{${letters(word.slice(-1)).trim()}}`;
          } else out += letters(word);
          continue;
        }
        i++;
        if (TEXHTML_SPACE.test(ch)) out += " ";
        else if (TEXHTML_SYMBOLS[ch]) out += TEXHTML_SYMBOLS[ch] + (/[a-z]$/i.test(TEXHTML_SYMBOLS[ch]) ? CMD_END : "");
        else if (/[0-9+=()[\],.;:/<>|!?'*@"-]/.test(ch)) out += ch;
        else throw new Error(`texhtml: unmapped ${ch}`);
      }
      return out;
    }
    if (node.nodeType !== 1) return "";

    const tag = tagOf(node);
    const cls = node.classList;
    if (TEXHTML_SKIP_TAGS.has(tag) || cls?.contains("sr-only") || cls?.contains("error")) return "";
    if (isWikiMath(node)) {
      const nested = tag === "math" ? extractStandaloneMathML(node) : extractWikiMath(node);
      if (!nested) throw new Error("texhtml: nested math without TeX");
      return `{${cleanWikiTex(nested.tex)}}`;
    }
    const inner = (it = italic) =>
      Array.from(node.childNodes || [], (c) => texHtmlToTex(c, it)).join("");

    if (tag === "i" || tag === "em" || tag === "var") return inner(true);
    if (tag === "b" || tag === "strong") {
      // \mathbf is already upright, so letters go in bare; Greek needs \boldsymbol.
      const body = inner(true).trim();
      return body.includes("\\") ? `\\boldsymbol{${body}}` : `\\mathbf{${body}}`;
    }
    if (tag === "sub" || tag === "sup") {
      const body = inner().trim();
      return `${tag === "sub" ? "_" : "^"}${body.length === 1 ? body : `{${body}}`}`;
    }
    if (tag === "br") return " ";
    if (cls?.contains("sfrac")) {
      const num = node.querySelector(".num");
      const den = node.querySelector(".den");
      if (!num || !den) throw new Error("texhtml: unknown sfrac layout");
      return `\\frac{${texHtmlToTex(num, italic).trim()}}{${texHtmlToTex(den, italic).trim()}}`;
    }
    // MathJax's rendering of a nested equation; its TeX comes from the hidden <math> beside it.
    if (tag === "mjx-container") {
      if (node.previousElementSibling?.querySelector?.("math")) return "";
      const rendered = extractMathJaxV3(node);
      if (!rendered) throw new Error("texhtml: unreadable MathJax");
      return `{${rendered.tex}}`;
    }
    if (tag === "span" || tag === "a") return inner();
    throw new Error(`texhtml: unmapped <${tag}>`);
  }

  // Set by content.js from the "Wikipedia text-style maths" setting.
  const options = { wikiInlineSymbols: true };

  function extractTexHtml(rootEl) {
    if (!options.wikiInlineSymbols || !rootEl.classList?.contains("texhtml")) return null;
    try {
      const tex = texHtmlToTex(rootEl, rootEl.classList.contains("mvar"))
        .replace(/\u0001(?=[A-Za-z])/g, " ")
        .replace(/\u0001/g, "")
        .replace(/\s+/g, " ")
        .replace(/ (?=[_^}])/g, "")
        .trim();
      return tex ? { tex, displayMode: false } : null;
    } catch {
      return null;
    }
  }

  function extractStandaloneMathML(rootEl) {
    const mw = readDataMwMath(rootEl);
    if (mw) return mw;

    const tex =
      readTexAnnotation(rootEl) || rootEl.getAttribute("alttext")?.trim() || "";
    if (!tex) return null;
    return {
      tex,
      displayMode: rootEl.getAttribute("display") === "block",
    };
  }

  function extractDataAttributeMath(rootEl) {
    const raw =
      rootEl.getAttribute("data-latex") ??
      rootEl.getAttribute("data-tex") ??
      rootEl.getAttribute("data-math");
    const tex = raw ? raw.trim() : "";
    if (!tex || BOOLEAN_FLAG_VALUES.has(tex.toLowerCase())) return null;

    const displayAttr = (
      rootEl.getAttribute("data-display") ||
      rootEl.getAttribute("display") ||
      ""
    ).toLowerCase();
    const displayMode =
      displayAttr === "true" ||
      displayAttr === "block" ||
      displayAttr === "display" ||
      rootEl.classList?.contains("math-display");

    return { tex, displayMode };
  }

  /**
   * Google Search / AI Overviews: equations are images inside `[data-xpm-copy-root]`. The root's
   * `data-xpm-latex` holds the full TeX; when absent, the image chunks hold it (joined with `\hphantom{}`).
   */
  function extractGoogleMath(rootEl) {
    let tex = rootEl.getAttribute("data-xpm-latex")?.trim() || "";
    if (!tex) {
      tex = Array.from(rootEl.querySelectorAll("[data-xpm-latex]"), (el) =>
        el.getAttribute("data-xpm-latex").replace(/\\hphantom\{\}/g, "")
      )
        .join("")
        .trim();
    }
    if (!tex) return null;

    // "block" is also used for lone variables inside sentences, so only treat it as display
    // maths when it's the only content in its block-level container.
    // Ctrl+C works on a detached copy of the selection, which has no layout, so tag names stand in.
    let displayMode = false;
    if (rootEl.getAttribute("data-xpm-math-type") === "block") {
      const isInline = (el) =>
        el.isConnected
          ? getComputedStyle(el).display.startsWith("inline")
          : INLINE_TAGS.has(el.tagName.toLowerCase());
      let box = rootEl.parentElement;
      while (box && isInline(box)) box = box.parentElement;
      // No block parent inside a copied fragment: compare against the whole fragment instead.
      const scope = box || rootEl.getRootNode?.();
      displayMode = !scope || scope.textContent.trim() === rootEl.textContent.trim();
    }
    return { tex, displayMode };
  }

  function extractLegacyImageMath(rootEl) {
    const src = rootEl.getAttribute("src") || "";
    let tex = rootEl.getAttribute("alt")?.trim() || "";

    if (!tex && src.includes("latex.codecogs.com")) {
      const qIndex = src.indexOf("?");
      if (qIndex !== -1) {
        try {
          tex = decodeURIComponent(src.slice(qIndex + 1).replace(/\+/g, " ")).trim();
          tex = tex.replace(/^\\(?:inline|dpi\{\d+\}|bg_[a-zA-Z0-9]+)\s*/g, "").trim();
        } catch {
          tex = "";
        }
      }
    }

    if (!tex && src.includes("latex.php")) {
      const match = src.match(/[?&]latex=([^&]+)/);
      if (match) {
        try {
          tex = decodeURIComponent(match[1].replace(/\+/g, " ")).trim();
        } catch {
          tex = "";
        }
      }
    }

    if (!tex) return null;
    const cleaned = cleanWikiTex(tex);
    const displayMode =
      rootEl.classList?.contains("display") ||
      tex.includes("\\displaystyle") ||
      src.includes("\\displaystyle");

    return { tex: cleaned || tex, displayMode };
  }

  function isMathJaxRoot(el) {
    if (!el || el.nodeType !== 1) return false;
    return tagOf(el) === "mjx-container" || hasAnyClass(el, MATHJAX2_CLASSES);
  }

  /**
   * Extracts `{ tex, displayMode }` from a math root element (or child node).
   * @param {Node} node
   * @returns {{ tex: string, displayMode: boolean, rootEl: Element } | null}
   */
  function extractMath(node) {
    const rootEl = findMathRoot(node);
    if (!rootEl) return null;

    const tag = tagOf(rootEl);
    let result = null;

    if (hasAnyClass(rootEl, KATEX_CLASSES)) {
      result = extractKatex(rootEl);
    } else if (tag === "mjx-container") {
      result = extractMathJaxV3(rootEl);
    } else if (hasAnyClass(rootEl, MATHJAX2_CLASSES)) {
      result = extractMathJaxV2(rootEl);
    } else if (isWikiMath(rootEl)) {
      result = extractWikiMath(rootEl);
    } else if (isLegacyImage(rootEl)) {
      result = extractLegacyImageMath(rootEl);
    } else if (rootEl.hasAttribute("data-xpm-copy-root")) {
      result = extractGoogleMath(rootEl);
    } else if (tag === "math") {
      result = extractStandaloneMathML(rootEl);
    } else if (rootEl.classList?.contains("texhtml")) {
      result = extractTexHtml(rootEl);
    } else if (rootEl.classList?.contains("nowrap")) {
      result = extractWikiIntegral(rootEl);
    } else if (
      rootEl.hasAttribute("data-latex") ||
      rootEl.hasAttribute("data-tex") ||
      rootEl.hasAttribute("data-math")
    ) {
      result = extractDataAttributeMath(rootEl);
    }

    if (!result || !result.tex) return null;
    // {{oiint}} on its own, with the rest written as the next <math>: "{\vphantom{\int}}_{∂Ω} E·dS = …".
    // The invisible integral only places the subscript, so put the real one back in its place.
    if (INTEGRAL_TAIL.test(result.tex)) {
      const lead = integralLeadBefore(rootEl);
      if (lead) {
        const tail = result.tex.replace(INTEGRAL_TAIL, "").replace(/^([_^])\{\s*\\(?:scriptstyle|textstyle)\s*/, "$1{");
        return { ...result, tex: lead + tail, rootEl, tookIntegral: true };
      }
    }
    return { ...result, rootEl };
  }

  const INTEGRAL_TAIL = /^\{?\s*\\vphantom\s*\{\\o?i+nt\}\s*\}?\s*(?=[_^])/;

  /** The integral sign of an image-only {{oiint}} just before el (hidden a11y copies skipped), or null. */
  function integralLeadBefore(el) {
    let prev = el.previousSibling;
    while (prev && ((prev.nodeType === 3 && !prev.textContent.trim()) || prev.classList?.contains("mwe-math-mathml-a11y"))) {
      prev = prev.previousSibling;
    }
    if (prev?.nodeType !== 1 || !prev.classList?.contains("nowrap")) return null;
    const tex = extractWikiIntegral(prev)?.tex;
    return WIKI_INTEGRALS.has(tex) ? tex : null;
  }

  /** True for an image-only {{oiint}} whose next equation takes it in, so it isn't copied twice. */
  function isIntegralLead(el) {
    if (!el.classList?.contains("nowrap") || !WIKI_INTEGRALS.has(extractWikiIntegral(el)?.tex)) return false;
    let next = el.nextSibling;
    while (next && ((next.nodeType === 3 && !next.textContent.trim()) || next.classList?.contains("mwe-math-mathml-a11y"))) {
      next = next.nextSibling;
    }
    return next?.nodeType === 1 && extractMath(next)?.tookIntegral === true;
  }

  /**
   * Checks whether the current Selection touches or contains any math element.
   * @param {Selection | null} selection
   * @returns {boolean}
   */
  function selectionContainsMath(selection) {
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      return false;
    }

    for (let i = 0; i < selection.rangeCount; i++) {
      const range = selection.getRangeAt(i);
      if (
        extractMath(range.startContainer) ||
        extractMath(range.endContainer) ||
        extractMath(range.commonAncestorContainer)
      ) {
        return true;
      }
      const ancestor = toElement(range.commonAncestorContainer);
      if (ancestor && typeof ancestor.querySelectorAll === "function") {
        const candidates = ancestor.querySelectorAll(MATH_ROOT_SELECTOR);
        for (const el of candidates) {
          if (
            typeof range.intersectsNode === "function" &&
            range.intersectsNode(el) &&
            extractMath(el)
          ) {
            return true;
          }
        }
      }
    }
    return false;
  }

  CopyMath.extractors = {
    MATH_ROOT_SELECTOR,
    options,
    requestMainWorldSync,
    cleanWikiTex,
    findMathRoot,
    isMathJaxRoot,
    extractMath,
    isIntegralLead,
    selectionContainsMath,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = CopyMath.extractors;
  }
})(typeof globalThis !== "undefined" ? globalThis : window);
