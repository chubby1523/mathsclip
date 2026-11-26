/**
 * Serializes a DOM Selection or Fragment containing KaTeX/MathJax/MathML/Wiki
 * math into Plain Text + LaTeX (default) or Markdown + LaTeX.
 */
(function initSerializer(root) {
  const CopyMath = (root.CopyMath = root.CopyMath || {});

  function getDeps() {
    if (CopyMath.extractors && CopyMath.formatTex) {
      return {
        DEFAULTS: CopyMath.DEFAULTS,
        formatTex: CopyMath.formatTex,
        extractors: CopyMath.extractors,
      };
    }
    if (typeof require === "function") {
      const defaults = require("./defaults.js");
      const extractors = require("./extractors.js");
      return {
        DEFAULTS: defaults.DEFAULTS,
        formatTex: defaults.formatTex,
        extractors,
      };
    }
    throw new Error("CopyMath dependencies not loaded.");
  }

  const SKIP_TAGS = new Set([
    "script",
    "style",
    "noscript",
    "template",
    "mjx-assistive-mml",
  ]);

  const UNCOPYABLE_ATTR = "data-mathsclip-skip";

  const DOUBLE_NEWLINE_BLOCKS = new Set([
    "p",
    "section",
    "article",
    "blockquote",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
  ]);

  const SINGLE_NEWLINE_BLOCKS = new Set(["div", "header", "footer", "aside", "nav"]);

  /**
   * Clones a Range and expands boundaries outward if the selection starts or ends
   * inside a math element (e.g. halfway inside KaTeX's `.katex-html`), preventing
   * partial clones from dropping `.katex-mathml`'s `<annotation>` TeX source.
   * @param {Range} range
   * @returns {Range}
   */
  function expandRangeForMath(range) {
    const { extractors } = getDeps();
    const cloned = range.cloneRange();

    const startMath = extractors.findMathRoot(cloned.startContainer);
    if (startMath) {
      cloned.setStartBefore(startMath);
    }

    const endMath = extractors.findMathRoot(cloned.endContainer);
    if (endMath) {
      cloned.setEndAfter(endMath);
    }

    return cloned;
  }

  function shouldSkipElement(el) {
    const tag = el.tagName?.toLowerCase();
    if (SKIP_TAGS.has(tag)) return true;
    if (
      el.classList?.contains("katex-mathml") ||
      el.classList?.contains("mwe-math-mathml-a11y")
    ) {
      return true;
    }
    if (el.hasAttribute?.("hidden") || el.hasAttribute?.(UNCOPYABLE_ATTR)) return true;
    if (getDeps().extractors.isIntegralLead(el)) return true; // copied as part of the next equation
    if (
      el.style?.display === "none" ||
      /display\s*:\s*none/i.test(el.getAttribute?.("style") || "")
    ) {
      return true;
    }
    // Skip Wikipedia's hidden MathML wrapper placed immediately before <mjx-container>.
    if (
      tag === "span" &&
      el.nextElementSibling?.tagName?.toLowerCase() === "mjx-container" &&
      el.querySelector?.("math")
    ) {
      return true;
    }
    return false;
  }

  function wrapInlineMarkdown(raw, marker) {
    const trimmed = raw.trim();
    if (!trimmed) return "";
    const lead = /^\s/.test(raw) ? " " : "";
    const trail = /\s$/.test(raw) ? " " : "";
    return `${lead}${marker}${trimmed}${marker}${trail}`;
  }

  function wrapInlineCode(text) {
    const content = text.replace(/\n+/g, " ").trim();
    if (!content) return "";
    if (!content.includes("`")) return `\`${content}\``;
    const pad = content.startsWith("`") || content.endsWith("`") ? " " : "";
    return `\`\`${pad}${content}${pad}\`\``;
  }

  function extractCodeLanguage(preEl) {
    const codeEl = preEl.querySelector?.("code") || preEl;
    const cls = codeEl.className || "";
    const match = String(cls).match(/(?:language-|lang-)([a-zA-Z0-9_+-]+)/);
    return match ? match[1] : "";
  }

  function formatExtractedMath(extracted, inTableCell, delimiters, formatTex) {
    const isBlock = !inTableCell && (extracted.displayMode || extracted.tex.includes("\n"));
    const tex = inTableCell ? extracted.tex.replace(/\s*\n\s*/g, " ") : extracted.tex;
    return { isBlock, formatted: formatTex(tex, isBlock, delimiters, "delimited") };
  }

  function mapSelectionFragments(selection, options, fn) {
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      return [];
    }
    if (!options || !options.skipSync) {
      getDeps().extractors.requestMainWorldSync();
    }

    const parts = [];
    for (let i = 0; i < selection.rangeCount; i++) {
      const expanded = expandRangeForMath(selection.getRangeAt(i));
      const marked = markUncopyable(expanded);
      let fragment;
      try {
        fragment = expanded.cloneContents();
      } finally {
        for (const el of marked) el.removeAttribute(UNCOPYABLE_ATTR);
      }
      const out = fn(fragment);
      if (out) parts.push(out);
    }
    return parts;
  }

  /**
   * The copy is built from a clone of the selection, and clones carry no styles. So before cloning,
   * tag the live elements the browser's own copy leaves out (display: none or user-select: none from
   * a stylesheet: Wikipedia's [edit] links, collapsed navboxes, show/hide toggles), and untag them
   * straight after. Maths is never tagged: its TeX is what we're copying, however it's styled.
   * @param {Range} range
   * @returns {Element[]} the elements tagged
   */
  function markUncopyable(range) {
    const { extractors } = getDeps();
    const top = range.commonAncestorContainer;
    const view = top?.ownerDocument?.defaultView;
    if (!view?.getComputedStyle || !top.isConnected) return [];

    const marked = [];
    const visit = (el) => {
      for (const child of el.children) {
        if (!range.intersectsNode(child)) continue;
        const style = view.getComputedStyle(child);
        if ((style.display === "none" || style.userSelect === "none") && !extractors.findMathRoot(child)) {
          child.setAttribute(UNCOPYABLE_ATTR, "");
          marked.push(child);
        } else {
          visit(child);
        }
      }
    };
    visit(top.nodeType === 1 ? top : top.parentElement);
    return marked;
  }

  function serializeChildren(node, ctx) {
    let out = "";
    const children = node.childNodes || [];
    for (const child of children) {
      let chunk = serializeNode(child, ctx);
      if (!ctx.preserveWhitespace && out.endsWith("\n") && child.nodeType === 3) {
        chunk = chunk.replace(/^[ \t]+/, "");
      }
      out += chunk;
    }
    return out;
  }

  function serializeList(listEl, isOrdered, ctx) {
    const nextCtx = { ...ctx, listDepth: ctx.listDepth + 1 };
    let index = Number(listEl.getAttribute?.("start")) || 1;
    let out = "";

    for (const child of listEl.childNodes || []) {
      if (child.nodeType !== 1) continue;
      if (child.tagName?.toLowerCase() !== "li") {
        out += serializeNode(child, nextCtx);
        continue;
      }

      const marker = isOrdered
        ? `${index}. `
        : ctx.isMarkdown
          ? "- "
          : "• ";
      index += 1;

      const body = serializeChildren(child, nextCtx).trim();
      if (body) {
        const indentedBody = body.replace(/\n(?!$)/g, "\n  ");
        out += `${marker}${indentedBody}\n`;
      }
    }

    const pad = ctx.listDepth === 0 ? "\n\n" : "\n";
    return out ? `${pad}${out.trimEnd()}${pad}` : "";
  }

  function serializeTable(tableEl, ctx) {
    // This table's own rows only: a nested table's rows are copied with the cell that holds it.
    const children = (el) => Array.from(el.children || []).filter((c) => !shouldSkipElement(c));
    const rows = children(tableEl).flatMap((c) => {
      const t = c.tagName?.toLowerCase();
      if (t === "tr") return [c];
      return t === "thead" || t === "tbody" || t === "tfoot" ? children(c).filter((r) => r.tagName?.toLowerCase() === "tr") : [];
    });
    if (rows.length === 0) return "";

    const matrix = rows.map((tr) =>
      children(tr)
        .filter((c) => {
          const t = c.tagName?.toLowerCase();
          return t === "td" || t === "th";
        })
        .map((cell) =>
          serializeChildren(cell, { ...ctx, inTableCell: true })
            .replace(/\s*\n\s*/g, " ")
            .trim()
        )
    );

    if (!ctx.isMarkdown) {
      return (
        "\n\n" +
        matrix.map((cells) => cells.join("\t")).join("\n") +
        "\n\n"
      );
    }

    const colCount = Math.max(...matrix.map((r) => r.length), 1);
    const padRow = (cells) => {
      const padded = [...cells];
      while (padded.length < colCount) padded.push("");
      return `| ${padded.map((c) => c.replace(/\|/g, "\\|")).join(" | ")} |`;
    };

    const lines = [padRow(matrix[0])];
    lines.push(`| ${Array(colCount).fill("---").join(" | ")} |`);
    for (let i = 1; i < matrix.length; i++) {
      lines.push(padRow(matrix[i]));
    }
    return `\n\n${lines.join("\n")}\n\n`;
  }

  function serializeNode(node, ctx) {
    if (!node) return "";

    if (node.nodeType === 3) {
      const text = node.textContent || "";
      if (ctx.preserveWhitespace) return text;
      return text.replace(/\s+/g, " ");
    }

    // DocumentFragment (11) or Document (9)
    if (node.nodeType === 11 || node.nodeType === 9) {
      return serializeChildren(node, ctx);
    }

    if (node.nodeType !== 1) return "";

    const { extractors, formatTex } = getDeps();

    if (shouldSkipElement(node)) return "";

    // Check if this element itself is a math root
    const mathRoot = extractors.findMathRoot(node);
    if (mathRoot === node) {
      const extracted = extractors.extractMath(node);
      if (extracted) {
        const { isBlock, formatted } = formatExtractedMath(
          extracted,
          ctx.inTableCell,
          ctx.delimiters,
          formatTex
        );
        return isBlock ? `\n\n${formatted}\n\n` : formatted;
      }
    }

    const tag = node.tagName.toLowerCase();

    if (tag === "br") return "\n";
    if (tag === "hr") return ctx.isMarkdown ? "\n\n---\n\n" : "\n\n";

    if (tag === "pre") {
      const code = serializeChildren(node, {
        ...ctx,
        preserveWhitespace: true,
      }).replace(/^\n+|\n+$/g, "");
      if (!code) return "";
      if (ctx.isMarkdown) {
        const lang = extractCodeLanguage(node);
        return `\n\n\`\`\`${lang}\n${code}\n\`\`\`\n\n`;
      }
      return `\n\n${code}\n\n`;
    }

    if (tag === "code") {
      const inner = serializeChildren(node, ctx);
      if (ctx.preserveWhitespace) return inner;
      return ctx.isMarkdown ? wrapInlineCode(inner) : inner;
    }

    if (tag === "ul") return serializeList(node, false, ctx);
    if (tag === "ol") return serializeList(node, true, ctx);
    if (tag === "table") return serializeTable(node, ctx);

    if (tag === "blockquote") {
      const inner = serializeChildren(node, ctx).trim();
      if (!inner) return "";
      if (ctx.isMarkdown) {
        const quoted = inner
          .split("\n")
          .map((line) => (line ? `> ${line}` : ">"))
          .join("\n");
        return `\n\n${quoted}\n\n`;
      }
      return `\n\n${inner}\n\n`;
    }

    if (/^h[1-6]$/.test(tag)) {
      const level = Number(tag[1]);
      const inner = serializeChildren(node, ctx).trim();
      if (!inner) return "";
      if (ctx.isMarkdown) {
        return `\n\n${"#".repeat(level)} ${inner}\n\n`;
      }
      return `\n\n${inner}\n\n`;
    }

    if (ctx.isMarkdown) {
      if (tag === "strong" || tag === "b") {
        return wrapInlineMarkdown(serializeChildren(node, ctx), "**");
      }
      if (tag === "em" || tag === "i") {
        return wrapInlineMarkdown(serializeChildren(node, ctx), "*");
      }
      if (tag === "del" || tag === "s") {
        return wrapInlineMarkdown(serializeChildren(node, ctx), "~~");
      }
      if (tag === "a") {
        const href = node.href || node.getAttribute?.("href") || "";
        const inner = serializeChildren(node, ctx).trim();
        if (!inner) return "";
        if (href && !href.trim().toLowerCase().startsWith("javascript:")) {
          return `[${inner}](${href})`;
        }
        return inner;
      }
      if (tag === "img") {
        const alt = node.getAttribute?.("alt")?.trim() || "";
        const src = node.getAttribute?.("src")?.trim() || "";
        return src ? `![${alt}](${src})` : alt;
      }
    } else if (tag === "img") {
      return node.getAttribute?.("alt")?.trim() || "";
    }

    const content = serializeChildren(node, ctx);
    if (!content) return "";

    if (DOUBLE_NEWLINE_BLOCKS.has(tag)) {
      return `\n\n${content.trim()}\n\n`;
    }
    if (SINGLE_NEWLINE_BLOCKS.has(tag)) {
      return `\n${content.trim()}\n`;
    }
    return content;
  }

  function cleanOutput(text) {
    return String(text || "")
      .replace(/⁠/g, "") // invisible word joiners Google puts after each equation
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  /**
   * Serializes a DOM Node or DocumentFragment into Plain Text + LaTeX or Markdown + LaTeX.
   * @param {Node} rootNode
   * @param {Partial<typeof CopyMath.DEFAULTS>} [userSettings]
   * @returns {string}
   */
  function serializeFragment(rootNode, userSettings) {
    const { DEFAULTS } = getDeps();
    const settings = { ...DEFAULTS, ...(userSettings || {}) };
    const ctx = {
      isMarkdown: settings.selectionFormat === "markdown",
      delimiters: settings.delimiters || "dollar",
      preserveWhitespace: false,
      listDepth: 0,
      inTableCell: false,
    };
    return cleanOutput(serializeNode(rootNode, ctx));
  }

  /**
   * Serializes a browser Selection into text/Markdown with embedded LaTeX.
   * @param {Selection | null} selection
   * @param {Partial<typeof CopyMath.DEFAULTS>} [userSettings]
   * @param {{ skipSync?: boolean }} [options]
   * @returns {string}
   */
  function serializeSelection(selection, userSettings, options = {}) {
    return mapSelectionFragments(selection, options, (fragment) =>
      serializeFragment(fragment, userSettings)
    ).join("\n\n");
  }

  /**
   * Walks a cloned DOM tree, removing hidden math/script helpers, resolving relative
   * link URLs, and replacing math roots with delimited TeX text nodes so rich HTML
   * clipboard paste preserves formatting alongside clean LaTeX.
   */
  function replaceMathInTree(node, ctx, doc) {
    const { extractors, formatTex } = getDeps();
    const children = Array.from(node.childNodes || []);
    const toRemove = [];

    for (const child of children) {
      if (child.nodeType !== 1) continue;

      if (shouldSkipElement(child)) {
        // Defer removal until after siblings are processed so math extractors
        // (e.g. Wikipedia's <mjx-container> reading its preceding hidden <math> sibling)
        // still see their sibling metadata during this pass.
        toRemove.push(child);
        continue;
      }

      const mathRoot = extractors.findMathRoot(child);
      if (mathRoot === child) {
        const extracted = extractors.extractMath(child);
        if (extracted) {
          const inTable = Boolean(ctx.inTableCell || child.closest?.("td, th"));
          const { isBlock, formatted } = formatExtractedMath(
            extracted,
            inTable,
            ctx.delimiters,
            formatTex
          );

          if (!isBlock) {
            node.replaceChild(doc.createTextNode(formatted), child);
          } else {
            const insideParagraph = Boolean(
              node.tagName?.toLowerCase() === "p" || node.closest?.("p")
            );
            const wrapper = doc.createElement(insideParagraph ? "span" : "p");
            const lines = formatted.split("\n");
            lines.forEach((line, idx) => {
              if (idx > 0) wrapper.appendChild(doc.createElement("br"));
              if (line) wrapper.appendChild(doc.createTextNode(line));
            });
            node.replaceChild(wrapper, child);
          }
          continue;
        }
      }

      const tag = child.tagName.toLowerCase();
      if (tag === "a") {
        const href = child.href || child.getAttribute?.("href") || "";
        if (href && !href.trim().toLowerCase().startsWith("javascript:")) {
          child.setAttribute?.("href", href);
        }
      }

      replaceMathInTree(
        child,
        { ...ctx, inTableCell: ctx.inTableCell || tag === "td" || tag === "th" },
        doc
      );
    }

    for (const dead of toRemove) {
      if (typeof dead.remove === "function") dead.remove();
      else if (typeof node.removeChild === "function") node.removeChild(dead);
    }
  }

  /**
   * Serializes a DOM Node or DocumentFragment into sanitized HTML with math swapped
   * for delimited LaTeX, preserving bold, headings, links, lists, and tables.
   * @param {Node} rootNode
   * @param {Partial<typeof CopyMath.DEFAULTS>} [userSettings]
   * @returns {string}
   */
  function serializeFragmentHtml(rootNode, userSettings) {
    if (!rootNode) return "";
    const doc =
      rootNode.ownerDocument || (typeof document !== "undefined" ? document : null);
    if (!doc || typeof doc.createElement !== "function") return "";

    const { DEFAULTS } = getDeps();
    const settings = { ...DEFAULTS, ...(userSettings || {}) };
    const ctx = {
      isMarkdown: false,
      delimiters: settings.delimiters || "dollar",
      preserveWhitespace: false,
      listDepth: 0,
      inTableCell: false,
    };

    const container = doc.createElement("div");
    container.appendChild(rootNode.cloneNode(true));
    replaceMathInTree(container, ctx, doc);
    return typeof container.innerHTML === "string"
      ? container.innerHTML.replace(/⁠/g, "").trim()
      : "";
  }

  /**
   * Serializes a browser Selection into rich HTML with math swapped for delimited LaTeX.
   * @param {Selection | null} selection
   * @param {Partial<typeof CopyMath.DEFAULTS>} [userSettings]
   * @param {{ skipSync?: boolean }} [options]
   * @returns {string}
   */
  function serializeSelectionHtml(selection, userSettings, options = {}) {
    return mapSelectionFragments(selection, options, (fragment) =>
      serializeFragmentHtml(fragment, userSettings)
    ).join("<br><br>");
  }

  CopyMath.serializer = {
    expandRangeForMath,
    serializeFragment,
    serializeSelection,
    serializeFragmentHtml,
    serializeSelectionHtml,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = CopyMath.serializer;
  }
})(typeof globalThis !== "undefined" ? globalThis : window);
