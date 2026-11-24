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
        !extractDataAttributeMath(candidate)
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
    const target = scopeEl.hasAttribute?.("data-mw")
      ? scopeEl
      : scopeEl.querySelector?.("[data-mw]");
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
    if (
      rootEl.querySelector?.("mjx-lazy") &&
      !rootEl.querySelector?.("svg, mjx-math") &&
      !rootEl.getAttribute("data-cm-tex")
    ) {
      return null;
    }

    // Fallback for Wikipedia 2026 MathJax SVG: hidden sibling <span><math>...</math></span> right before <mjx-container>
    const prev = rootEl.previousElementSibling;
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
    } else if (
      rootEl.hasAttribute("data-latex") ||
      rootEl.hasAttribute("data-tex") ||
      rootEl.hasAttribute("data-math")
    ) {
      result = extractDataAttributeMath(rootEl);
    }

    if (!result || !result.tex) return null;
    return { ...result, rootEl };
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
    requestMainWorldSync,
    cleanWikiTex,
    findMathRoot,
    isMathJaxRoot,
    extractMath,
    selectionContainsMath,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = CopyMath.extractors;
  }
})(typeof globalThis !== "undefined" ? globalThis : window);
