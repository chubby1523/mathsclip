/**
 * Runs in Chrome's MAIN execution world so it can read page-level window.MathJax
 * objects (v2, v3, v4) that are hidden from ISOLATED content scripts.
 * Stamps extracted TeX onto rendered math DOM elements via data-cm-tex / data-cm-display.
 */
(function initMainWorld() {
  const SYNC_EVENT = "copy-math:sync";

  function cleanWikiTex(raw) {
    let text = typeof raw === "string" ? raw.trim() : "";
    if (!text) return "";
    const wrappedMatch = text.match(
      /^\{\s*\\(?:displaystyle|textstyle|scriptstyle|scriptscriptstyle)\s+([\s\S]*)\}$/
    );
    if (wrappedMatch) {
      text = wrappedMatch[1].trim();
    }
    return text.replace(/^\\(?:displaystyle|textstyle)\s+/, "").trim();
  }

  function decodeXmlEntities(str) {
    return String(str || "")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'")
      .replace(/&amp;/g, "&");
  }

  function parseDataMwTex(rawJson) {
    if (!rawJson || typeof rawJson !== "string") return null;
    try {
      const parsed = JSON.parse(rawJson);
      if (parsed?.name !== "math" || typeof parsed?.body?.extsrc !== "string") {
        return null;
      }
      const tex = cleanWikiTex(parsed.body.extsrc);
      if (!tex) return null;
      return {
        tex,
        displayMode: parsed?.attrs?.display === "block",
      };
    } catch {
      return null;
    }
  }

  function extractTexFromMathMLItem(item) {
    const startNode = item?.start?.node;
    if (startNode && startNode.nodeType === 1) {
      const mwNode = startNode.hasAttribute?.("data-mw")
        ? startNode
        : startNode.querySelector?.("[data-mw]");
      const mw = parseDataMwTex(mwNode?.getAttribute?.("data-mw"));
      if (mw) return mw;

      const ann =
        startNode.querySelector?.('annotation[encoding="application/x-tex"]') ||
        startNode.querySelector?.('annotation[encoding="application/x-latex"]') ||
        startNode.querySelector?.("annotation");
      const raw = ann?.textContent || startNode.getAttribute?.("alttext") || "";
      const cleaned = cleanWikiTex(raw);
      if (cleaned) {
        return {
          tex: cleaned,
          displayMode: startNode.getAttribute?.("display") === "block",
        };
      }
    }

    if (typeof item?.math === "string") {
      const mwAttrMatch =
        item.math.match(/data-mw="([^"]*)"/i) ||
        item.math.match(/data-mw='([^']*)'/i);
      if (mwAttrMatch && mwAttrMatch[1]) {
        const mw = parseDataMwTex(decodeXmlEntities(mwAttrMatch[1]));
        if (mw) return mw;
      }

      const m =
        item.math.match(
          /<annotation[^>]*encoding=["']application\/x-(?:tex|latex)["'][^>]*>([\s\S]*?)<\/annotation>/i
        ) ||
        item.math.match(/<annotation[^>]*>([\s\S]*?)<\/annotation>/i) ||
        item.math.match(/alttext=["']([^"']+)["']/i);
      if (m && m[1]) {
        const cleaned = cleanWikiTex(decodeXmlEntities(m[1]));
        if (cleaned) {
          return {
            tex: cleaned,
            displayMode: /display=["']block["']/.test(item.math),
          };
        }
      }
    }

    return null;
  }

  function stampElement(el, tex, displayMode) {
    if (!el || typeof el.setAttribute !== "function") return;
    const trimmed = typeof tex === "string" ? tex.trim() : "";
    if (!trimmed) return;
    if (el.getAttribute("data-cm-tex") !== trimmed) {
      el.setAttribute("data-cm-tex", trimmed);
    }
    const displayVal = displayMode ? "true" : "false";
    if (el.getAttribute("data-cm-display") !== displayVal) {
      el.setAttribute("data-cm-display", displayVal);
    }
  }

  function syncMathJaxV3() {
    const mathList = window.MathJax?.startup?.document?.math;
    if (!mathList) return;

    try {
      for (const item of mathList) {
        if (!item || !item.typesetRoot) continue;
        const inputName = item.inputJax?.name;
        if (inputName === "MathML") {
          const extracted = extractTexFromMathMLItem(item);
          if (extracted && extracted.tex) {
            const isDisplay = Boolean(item.display || extracted.displayMode);
            stampElement(item.typesetRoot, extracted.tex, isDisplay);
          }
          continue;
        }
        if (inputName && inputName !== "TeX") continue;
        if (typeof item.math === "string" && item.math.trim()) {
          stampElement(item.typesetRoot, item.math, Boolean(item.display));
        }
      }
    } catch {
      // Ignore sites with non-standard or partially initialized MathJax globals.
    }
  }

  function syncMathJaxV2() {
    const hub = window.MathJax?.Hub;
    if (!hub || typeof hub.getAllJax !== "function") return;

    try {
      const jaxList = hub.getAllJax();
      for (const jax of jaxList) {
        if (!jax || typeof jax.originalText !== "string") continue;
        if (jax.inputJax && jax.inputJax !== "TeX") continue;

        const sourceEl =
          typeof jax.SourceElement === "function" ? jax.SourceElement() : null;
        const isDisplay = Boolean(
          sourceEl?.type?.includes("mode=display") || jax.root?.display === "block"
        );

        const frameEl = jax.inputID
          ? document.getElementById(`${jax.inputID}-Frame`)
          : null;
        if (frameEl) {
          stampElement(frameEl, jax.originalText, isDisplay);
          const displayWrapper = frameEl.closest(".MathJax_Display, .MJXc-display");
          if (displayWrapper) {
            stampElement(displayWrapper, jax.originalText, true);
          }
        }
      }
    } catch {
      // Ignore non-standard MathJax v2 configurations.
    }
  }

  function syncAll() {
    if (!window.MathJax) return;
    syncMathJaxV3();
    syncMathJaxV2();
  }

  document.addEventListener(SYNC_EVENT, syncAll);
  syncAll();
})();
