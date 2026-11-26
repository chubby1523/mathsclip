const test = require("node:test");
const assert = require("node:assert/strict");

const defaults = require("../src/defaults.js");
const extractors = require("../src/extractors.js");
const serializer = require("../src/serializer.js");

/**
 * Lightweight DOM mock implementing the subset of DOM/Range APIs used by
 * extractors.js and serializer.js so tests run with zero external npm packages.
 */
class MockClassList {
  constructor(el) {
    this.el = el;
  }
  _set() {
    const raw = this.el.attrs.class || "";
    return new Set(raw.split(/\s+/).filter(Boolean));
  }
  contains(name) {
    return this._set().has(name);
  }
}

class MockNode {
  constructor(nodeType) {
    this.nodeType = nodeType;
    this.parentNode = null;
    this.childNodes = [];
    this.ownerDocument = null;
  }
  get parentElement() {
    return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null;
  }
  getRootNode() {
    let cur = this;
    while (cur.parentNode) cur = cur.parentNode;
    return cur;
  }
  get previousSibling() {
    const siblings = this.parentNode?.childNodes || [];
    return siblings[siblings.indexOf(this) - 1] || null;
  }
  get nextSibling() {
    const siblings = this.parentNode?.childNodes || [];
    const idx = siblings.indexOf(this);
    return idx >= 0 ? siblings[idx + 1] || null : null;
  }
  get nextElementSibling() {
    if (!this.parentNode) return null;
    const siblings = this.parentNode.childNodes;
    const idx = siblings.indexOf(this);
    for (let i = idx + 1; i < siblings.length; i++) {
      if (siblings[i].nodeType === 1) return siblings[i];
    }
    return null;
  }
  get previousElementSibling() {
    if (!this.parentNode) return null;
    const siblings = this.parentNode.childNodes;
    const idx = siblings.indexOf(this);
    for (let i = idx - 1; i >= 0; i--) {
      if (siblings[i].nodeType === 1) return siblings[i];
    }
    return null;
  }
  appendChild(child) {
    const doc = this.ownerDocument || (this.nodeType === 9 ? this : null);
    if (child.nodeType === 11) {
      const moved = [...child.childNodes];
      child.childNodes = [];
      for (const c of moved) {
        this.appendChild(c);
      }
      return child;
    }
    child.parentNode = this;
    const propagateDoc = (node) => {
      if (doc) node.ownerDocument = doc;
      for (const c of node.childNodes || []) propagateDoc(c);
    };
    propagateDoc(child);
    this.childNodes.push(child);
    return child;
  }
  replaceChild(newChild, oldChild) {
    const idx = this.childNodes.indexOf(oldChild);
    if (idx === -1) return oldChild;
    oldChild.parentNode = null;
    if (newChild.nodeType === 11) {
      const moved = [...newChild.childNodes];
      moved.forEach((c) => {
        c.parentNode = this;
        c.ownerDocument = this.ownerDocument || oldChild.ownerDocument;
      });
      this.childNodes.splice(idx, 1, ...moved);
    } else {
      newChild.parentNode = this;
      newChild.ownerDocument = this.ownerDocument || oldChild.ownerDocument;
      this.childNodes[idx] = newChild;
    }
    return oldChild;
  }
  removeChild(child) {
    const idx = this.childNodes.indexOf(child);
    if (idx !== -1) {
      this.childNodes.splice(idx, 1);
      child.parentNode = null;
    }
    return child;
  }
  remove() {
    if (this.parentNode && typeof this.parentNode.removeChild === "function") {
      this.parentNode.removeChild(this);
    }
  }
}

class MockText extends MockNode {
  constructor(text) {
    super(3);
    this.textContent = text;
  }
  cloneNode() {
    return new MockText(this.textContent);
  }
}

function matchesSingleSelector(el, sel) {
  sel = sel.trim();
  if (!sel || el.nodeType !== 1) return false;

  // Support simple combinations like `annotation[encoding="application/x-tex"]`, `math[display="block"]`, `.class`, `tag`
  const attrRegex = /\[([^\]=*~]+)(?:([*~]?=)"([^"]*)")?\]/g;
  const attrChecks = [];
  let stripped = sel.replace(attrRegex, (_, key, op, val) => {
    attrChecks.push({ key, op, val });
    return "";
  });

  const parts = stripped.split(".");
  const tagPart = parts[0].trim().toLowerCase();
  const classParts = parts.slice(1).filter(Boolean);

  if (tagPart && el.tagName.toLowerCase() !== tagPart) return false;
  for (const cls of classParts) {
    if (!el.classList.contains(cls)) return false;
  }
  for (const { key, op, val } of attrChecks) {
    const actual = el.getAttribute(key);
    if (!op) {
      if (actual === null) return false;
    } else if (op === "=") {
      if (actual !== val) return false;
    } else if (op === "*=") {
      if (!actual || !actual.includes(val)) return false;
    }
  }
  return true;
}

function matchesSelector(el, selectorList) {
  return selectorList
    .split(",")
    .map((s) => s.trim())
    .some((part) => {
      if (part.includes(">")) {
        const [parentSel, childSel] = part.split(">").map((x) => x.trim());
        return (
          matchesSingleSelector(el, childSel) &&
          el.parentElement &&
          matchesSingleSelector(el.parentElement, parentSel)
        );
      }
      return matchesSingleSelector(el, part);
    });
}

const VOID_HTML_TAGS = new Set(["br", "hr", "img", "input"]);

function escapeHtmlText(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeHtmlAttr(str) {
  return escapeHtmlText(str).replace(/"/g, "&quot;");
}

function serializeMockChildrenHtml(node) {
  return (node.childNodes || [])
    .map((child) => {
      if (child.nodeType === 3) return escapeHtmlText(child.textContent);
      if (child.nodeType === 1) return child.outerHTML;
      return "";
    })
    .join("");
}

class MockElement extends MockNode {
  constructor(tagName, attrs = {}, children = []) {
    super(1);
    this.tagName = tagName.toUpperCase();
    this.attrs = { ...attrs };
    this.classList = new MockClassList(this);
    for (const child of children) this.appendChild(child);
  }
  get innerHTML() {
    return serializeMockChildrenHtml(this);
  }
  get outerHTML() {
    const tag = this.tagName.toLowerCase();
    const attrStr = Object.entries(this.attrs)
      .map(([k, v]) => ` ${k}="${escapeHtmlAttr(v)}"`)
      .join("");
    if (VOID_HTML_TAGS.has(tag)) return `<${tag}${attrStr}>`;
    return `<${tag}${attrStr}>${this.innerHTML}</${tag}>`;
  }
  get id() {
    return this.attrs.id || "";
  }
  get className() {
    return this.attrs.class || "";
  }
  get type() {
    return this.attrs.type || "";
  }
  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attrs, name)
      ? this.attrs[name]
      : null;
  }
  setAttribute(name, val) {
    this.attrs[name] = String(val);
  }
  hasAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attrs, name);
  }
  removeAttribute(name) {
    delete this.attrs[name];
  }
  get children() {
    return this.childNodes.filter((n) => n.nodeType === 1);
  }
  get textContent() {
    return this.childNodes.map((c) => c.textContent).join("");
  }
  closest(selectorList) {
    let cur = this;
    while (cur && cur.nodeType === 1) {
      if (matchesSelector(cur, selectorList)) return cur;
      cur = cur.parentElement;
    }
    return null;
  }
  querySelector(selectorList) {
    return this.querySelectorAll(selectorList)[0] || null;
  }
  querySelectorAll(selectorList) {
    const out = [];
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType === 1) {
          if (matchesSelector(child, selectorList)) out.push(child);
          walk(child);
        }
      }
    };
    walk(this);
    return out;
  }
  cloneNode(deep = false) {
    const copy = new MockElement(this.tagName.toLowerCase(), this.attrs);
    copy.ownerDocument = this.ownerDocument;
    if (Object.prototype.hasOwnProperty.call(this, "href")) {
      copy.href = this.href;
    }
    if (deep) {
      for (const child of this.childNodes) {
        copy.appendChild(child.cloneNode(true));
      }
    }
    return copy;
  }
}

class MockFragment extends MockNode {
  constructor(children = []) {
    super(11);
    for (const c of children) this.appendChild(c);
  }
  get textContent() {
    return this.childNodes.map((c) => c.textContent).join("");
  }
  cloneNode(deep = false) {
    const copy = new MockFragment();
    copy.ownerDocument = this.ownerDocument;
    if (deep) {
      for (const child of this.childNodes) {
        copy.appendChild(child.cloneNode(true));
      }
    }
    return copy;
  }
  querySelector(sel) {
    for (const c of this.childNodes) {
      if (c.nodeType === 1) {
        if (matchesSelector(c, sel)) return c;
        const found = c.querySelector(sel);
        if (found) return found;
      }
    }
    return null;
  }
}

class MockDocument extends MockNode {
  constructor() {
    super(9);
    this.ownerDocument = this;
  }
  createElement(tag) {
    const node = new MockElement(tag);
    node.ownerDocument = this;
    return node;
  }
  createTextNode(text) {
    const node = new MockText(text);
    node.ownerDocument = this;
    return node;
  }
  querySelector(sel) {
    for (const c of this.childNodes) {
      if (c.nodeType !== 1) continue;
      if (matchesSelector(c, sel)) return c;
      const found = c.querySelector(sel);
      if (found) return found;
    }
    return null;
  }
  getElementById(id) {
    const walk = (n) => {
      for (const c of n.childNodes) {
        if (c.nodeType === 1) {
          if (c.id === id) return c;
          const found = walk(c);
          if (found) return found;
        }
      }
      return null;
    };
    return walk(this);
  }
}

const el = (tag, attrs = {}, ...children) =>
  new MockElement(
    tag,
    attrs,
    children.flat().map((c) => (typeof c === "string" ? new MockText(c) : c))
  );

const katexInline = (tex, visual = "x") =>
  el(
    "span",
    { class: "katex" },
    el(
      "span",
      { class: "katex-mathml" },
      el("math", {}, el("semantics", {}, el("annotation", { encoding: "application/x-tex" }, tex)))
    ),
    el("span", { class: "katex-html", "aria-hidden": "true" }, visual)
  );

const katexDisplay = (tex, visual = "X") =>
  el(
    "span",
    { class: "katex-display" },
    el(
      "span",
      { class: "katex" },
      el(
        "span",
        { class: "katex-mathml" },
        el("math", { display: "block" }, el("semantics", {}, el("annotation", { encoding: "application/x-tex" }, tex)))
      ),
      el("span", { class: "katex-html", "aria-hidden": "true" }, visual)
    )
  );

test("defaults.formatTex formats raw and delimited math correctly", () => {
  assert.equal(defaults.formatTex("  x^2 ", false, "dollar", "raw"), "x^2");
  assert.equal(defaults.formatTex("x^2", false, "dollar", "delimited"), "$x^2$");
  assert.equal(defaults.formatTex("x^2", true, "dollar", "delimited"), "$$\nx^2\n$$");
  assert.equal(defaults.formatTex("x^2", false, "parens", "delimited"), "\\(x^2\\)");
  assert.equal(defaults.formatTex("x^2", true, "parens", "delimited"), "\\[\nx^2\n\\]");
  assert.equal(
    defaults.formatTex("% comment\na + b", false, "dollar", "delimited"),
    "$$\n% comment\na + b\n$$"
  );
  assert.equal(
    defaults.formatTex("a + b\nc + d", false, "parens", "delimited"),
    "\\[\na + b\nc + d\n\\]"
  );
});

test("extractors extract KaTeX inline and display without double-matching", () => {
  const inline = katexInline("E = mc^2", "E=mc²");
  const display = katexDisplay("\\sum_{i=1}^n i", "∑ i");

  const innerKatex = display.querySelector(".katex");
  const rootFromVisual = extractors.findMathRoot(innerKatex.querySelector(".katex-html"));
  assert.equal(rootFromVisual, display);

  assert.deepEqual(
    { tex: extractors.extractMath(inline).tex, displayMode: extractors.extractMath(inline).displayMode },
    { tex: "E = mc^2", displayMode: false }
  );
  assert.deepEqual(
    { tex: extractors.extractMath(display).tex, displayMode: extractors.extractMath(display).displayMode },
    { tex: "\\sum_{i=1}^n i", displayMode: true }
  );
});

test("extractors extract MathJax v3 (stamped + assistive fallback) and MathJax v2", () => {
  const mjxStamped = el("mjx-container", { "data-cm-tex": "\\alpha + \\beta", "data-cm-display": "false" });
  const mjxAssistive = el(
    "mjx-container",
    { display: "true" },
    el("mjx-assistive-mml", {}, el("math", {}, el("annotation", { encoding: "application/x-tex" }, "\\int_0^1 x\\,dx")))
  );

  assert.deepEqual(
    { tex: extractors.extractMath(mjxStamped).tex, displayMode: extractors.extractMath(mjxStamped).displayMode },
    { tex: "\\alpha + \\beta", displayMode: false }
  );
  assert.deepEqual(
    { tex: extractors.extractMath(mjxAssistive).tex, displayMode: extractors.extractMath(mjxAssistive).displayMode },
    { tex: "\\int_0^1 x\\,dx", displayMode: true }
  );

  const doc = new MockDocument();
  const frame = el("span", { class: "MathJax", id: "MathJax-Element-7-Frame" }, "e^x");
  const script = el("script", { type: "math/tex; mode=display", id: "MathJax-Element-7" }, "e^x");
  const container = el("p", {}, frame, script);
  doc.appendChild(container);

  const v2Result = extractors.extractMath(frame);
  assert.equal(v2Result.tex, "e^x");
  assert.equal(v2Result.displayMode, true);
});

test("extractors clean Wikipedia display wrappers from image alt text", () => {
  const wiki = el(
    "span",
    { class: "mwe-math-element" },
    el("img", {
      class: "mwe-math-fallback-image-inline",
      alt: "{\\displaystyle P(A\\mid B)=\\frac{P(B\\mid A)P(A)}{P(B)}}",
    })
  );
  const res = extractors.extractMath(wiki);
  assert.equal(res.tex, "P(A\\mid B)=\\frac{P(B\\mid A)P(A)}{P(B)}");
  assert.equal(res.displayMode, false);
});

test("extractors support generic data-latex/data-tex/data-math and ignore boolean flags", () => {
  const inlineData = el("span", { "data-latex": "\\nabla \\cdot E = \\frac{\\rho}{\\varepsilon_0}" }, "∇·E");
  const displayData = el("div", { "data-tex": "F = ma", "data-display": "true" }, "F=ma");
  const booleanFlag = el("div", { "data-math": "true" }, "Just plain text");

  assert.deepEqual(
    { tex: extractors.extractMath(inlineData).tex, displayMode: extractors.extractMath(inlineData).displayMode },
    { tex: "\\nabla \\cdot E = \\frac{\\rho}{\\varepsilon_0}", displayMode: false }
  );
  assert.deepEqual(
    { tex: extractors.extractMath(displayData).tex, displayMode: extractors.extractMath(displayData).displayMode },
    { tex: "F = ma", displayMode: true }
  );
  assert.equal(extractors.extractMath(booleanFlag), null);
});

test("extractors read Google AI Overview data-xpm-latex and ignore spoken-text annotations", () => {
  const speech = () =>
    el("div", {}, el("math", {}, el("semantics", {}, el("mi", {}, "x"), el("annotation", { encoding: "text/plain" }, "x equals y"))));

  // Full TeX on the root; hovering the invisible overlay <math> must resolve to the root.
  const overlay = speech();
  const chunk = el("img", { "data-xpm-latex": "ax^2 " });
  const whole = el("div", { "data-xpm-copy-root": "", "data-xpm-math-type": "inline", "data-xpm-latex": "ax^2 + bx + c = 0" }, chunk, overlay);
  assert.equal(extractors.findMathRoot(overlay.childNodes[0]), whole);
  assert.equal(extractors.findMathRoot(chunk), whole);
  assert.deepEqual(
    { tex: extractors.extractMath(chunk).tex, displayMode: extractors.extractMath(chunk).displayMode },
    { tex: "ax^2 + bx + c = 0", displayMode: false }
  );

  // No root TeX: join the image chunks, dropping Google's \hphantom{} joiners.
  const chunked = el(
    "div",
    { "data-xpm-copy-root": "", "data-xpm-math-type": "inline" },
    el("img", { "data-xpm-latex": "a " }),
    el("img", { "data-xpm-latex": "\\hphantom{}\\neq 0" })
  );
  assert.equal(extractors.extractMath(chunked).tex, "a \\neq 0");

  // A bare <math> with only a spoken-text annotation has no TeX.
  const bare = speech();
  assert.equal(extractors.findMathRoot(bare.childNodes[0]), null);
});

test("Google 'block' equations are display maths only when they stand alone, also in copied fragments", () => {
  const googleBlock = (tex) =>
    el("span", { "data-xpm-copy-root": "", "data-xpm-math-type": "block", "data-xpm-latex": tex }, el("img", {}));

  // Ctrl+C clones the selection: a lone variable sits straight in the fragment, next to the sentence.
  const lone = googleBlock("x");
  new MockFragment([new MockText("where "), lone, new MockText(" is the unknown")]);
  assert.equal(extractors.extractMath(lone).displayMode, false);

  // Same, wrapped in an inline span inside a paragraph.
  const wrapped = googleBlock("x");
  el("p", {}, "where ", el("span", {}, wrapped), " is the unknown");
  assert.equal(extractors.extractMath(wrapped).displayMode, false);

  // A formula on its own line is display maths.
  const alone = googleBlock("x = 1");
  el("div", {}, el("span", {}, alone));
  assert.equal(extractors.extractMath(alone).displayMode, true);

  const output = serializer.serializeFragment(
    new MockFragment([new MockText("where "), googleBlock("x"), new MockText(" is the unknown")]),
    { selectionFormat: "plain", delimiters: "dollar" }
  );
  assert.equal(output, "where $x$ is the unknown");
});

test("extractors support CodeCogs and WordPress legacy math images", () => {
  const codecogsWithAlt = el("img", {
    src: "https://latex.codecogs.com/svg.image?a%5E2%2Bb%5E2%3Dc%5E2",
    alt: "a^2+b^2=c^2",
  });
  const codecogsFromSrc = el("img", {
    src: "https://latex.codecogs.com/gif.latex?%5Cinline%20%5Cfrac%7B1%7D%7Bx%7D",
  });
  const wpLatex = el("img", {
    class: "latex",
    src: "https://s0.wp.com/latex.php?latex=e%5Ex&bg=ffffff",
    alt: "e^x",
  });

  assert.equal(extractors.extractMath(codecogsWithAlt).tex, "a^2+b^2=c^2");
  assert.equal(extractors.extractMath(codecogsFromSrc).tex, "\\frac{1}{x}");
  assert.equal(extractors.extractMath(wpLatex).tex, "e^x");
});

test("serializer outputs Plain Text + LaTeX by default and preserves normal text", () => {
  const frag = new MockFragment([
    el("p", {}, "Energy is ", katexInline("E=mc^2"), " in relativity."),
    katexDisplay("a^2 + b^2 = c^2"),
    el("p", {}, "With ", el("strong", {}, "bold"), " and ", el("code", {}, "x_0"), "."),
  ]);

  const plainDollar = serializer.serializeFragment(frag, {
    selectionFormat: "plain",
    delimiters: "dollar",
  });
  assert.equal(
    plainDollar,
    "Energy is $E=mc^2$ in relativity.\n\n$$\na^2 + b^2 = c^2\n$$\n\nWith bold and x_0."
  );

  const plainParens = serializer.serializeFragment(frag, {
    selectionFormat: "plain",
    delimiters: "parens",
  });
  assert.equal(
    plainParens,
    "Energy is \\(E=mc^2\\) in relativity.\n\n\\[\na^2 + b^2 = c^2\n\\]\n\nWith bold and x_0."
  );
});

test("serializer outputs Markdown + LaTeX when markdown format is chosen", () => {
  const frag = new MockFragment([
    el("h2", {}, "Results"),
    el(
      "p",
      {},
      "See ",
      el("a", { href: "https://example.com" }, "proof"),
      " for ",
      katexInline("\\theta"),
      " and ",
      el("strong", {}, "key"),
      "."
    ),
    el(
      "ul",
      {},
      el("li", {}, "First ", katexInline("x_1")),
      el("li", {}, "Second", el("ul", {}, el("li", {}, "Nested ", katexInline("x_2"))))
    ),
    el("pre", {}, el("code", { class: "language-py" }, "def f(x):\n    return x + 1")),
  ]);

  const md = serializer.serializeFragment(frag, {
    selectionFormat: "markdown",
    delimiters: "dollar",
  });

  assert.equal(
    md,
    [
      "## Results",
      "",
      "See [proof](https://example.com) for $\\theta$ and **key**.",
      "",
      "- First $x_1$",
      "- Second",
      "  - Nested $x_2$",
      "",
      "```py",
      "def f(x):",
      "    return x + 1",
      "```",
    ].join("\n")
  );
});

test("serializer expandRangeForMath expands partial math selection boundaries", () => {
  const katex = katexInline("a+b", "a+b");
  const visualText = katex.querySelector(".katex-html").childNodes[0];
  const prefixText = new MockText("Let ");
  el("p", {}, prefixText, katex);

  let startBeforeArg = null;
  let endAfterArg = null;
  const fakeRange = {
    startContainer: prefixText,
    endContainer: visualText,
    cloneRange() {
      return {
        startContainer: this.startContainer,
        endContainer: this.endContainer,
        setStartBefore(node) {
          startBeforeArg = node;
        },
        setEndAfter(node) {
          endAfterArg = node;
        },
      };
    },
  };

  serializer.expandRangeForMath(fakeRange);
  assert.equal(startBeforeArg, null);
  assert.equal(endAfterArg, katex);
});

test("findMathRoot and expandRangeForMath ignore false-positive [data-math='true'] containers", () => {
  const normalText = new MockText("A normal sentence inside an article.");
  const katex = katexInline("x^2 + y^2 = z^2", "x²+y²=z²");
  const p = el("p", {}, normalText, " ", katex);
  const article = el("article", { "data-math": "true" }, p);

  assert.equal(extractors.findMathRoot(normalText), null);
  assert.equal(extractors.findMathRoot(p), null);
  assert.equal(extractors.findMathRoot(article), null);
  assert.equal(extractors.findMathRoot(katex), katex);

  let startBeforeArg = null;
  let endAfterArg = null;
  const fakeRange = {
    startContainer: normalText,
    endContainer: normalText,
    cloneRange() {
      return {
        startContainer: this.startContainer,
        endContainer: this.endContainer,
        setStartBefore(node) {
          startBeforeArg = node;
        },
        setEndAfter(node) {
          endAfterArg = node;
        },
      };
    },
  };

  serializer.expandRangeForMath(fakeRange);
  assert.equal(startBeforeArg, null);
  assert.equal(endAfterArg, null);
});

test("extractors extract correct TeX from multi-equation MathJax v2 paragraph with preview siblings", () => {
  const eq1 = el("span", { class: "MathJax" }, "a+b");
  const preview1 = el("span", { class: "MathJax_Preview" });
  const script1 = el("script", { type: "math/tex" }, "a + b");

  const eq2 = el("span", { class: "MathJax" }, "c+d");
  const preview2 = el("span", { class: "MathJax_Preview" });
  const script2 = el("script", { type: "math/tex" }, "c + d");

  el("p", {}, "First: ", eq1, preview1, script1, " and second: ", eq2, preview2, script2);

  assert.equal(extractors.extractMath(eq1).tex, "a + b");
  assert.equal(extractors.extractMath(eq2).tex, "c + d");
});

test("findMathRoot returns null for standalone <math> without annotation or alttext", () => {
  const bareMi = el("mi", {}, "x");
  const bareMath = el("math", {}, el("mrow", {}, bareMi));
  assert.equal(extractors.findMathRoot(bareMi), null);
  assert.equal(extractors.findMathRoot(bareMath), null);

  const annotatedMath = el(
    "math",
    {},
    el("semantics", {}, el("mi", {}, "x"), el("annotation", { encoding: "application/x-tex" }, "x_0"))
  );
  assert.equal(extractors.findMathRoot(annotatedMath), annotatedMath);
  assert.equal(extractors.extractMath(annotatedMath).tex, "x_0");
});

test("serializer preserves inline Markdown spacing, resolves a.href, and keeps table cell math inline", () => {
  const relLink = el("a", { href: "/docs/guide" }, "Guide");
  relLink.href = "https://example.com/docs/guide";

  const table = el(
    "table",
    {},
    el("tr", {}, el("th", {}, "Name"), el("th", {}, "Formula")),
    el("tr", {}, el("td", {}, "Pythagoras"), el("td", {}, katexDisplay("a^2 + b^2 = c^2")))
  );

  const frag = new MockFragment([
    el("p", {}, "Hello", el("strong", {}, " bold "), "world and ", relLink, "."),
    table,
  ]);

  const md = serializer.serializeFragment(frag, {
    selectionFormat: "markdown",
    delimiters: "dollar",
  });

  assert.equal(
    md,
    [
      "Hello **bold** world and [Guide](https://example.com/docs/guide).",
      "",
      "| Name | Formula |",
      "| --- | --- |",
      "| Pythagoras | $a^2 + b^2 = c^2$ |",
    ].join("\n")
  );
});

test("serializer.serializeFragmentHtml preserves rich HTML, resolves links, and strips hidden math helpers", () => {
  const doc = new MockDocument();
  const relLink = el("a", { href: "/docs/guide" }, "Guide");
  relLink.href = "https://example.com/docs/guide";

  const frag = new MockFragment([
    el(
      "p",
      {},
      el("strong", {}, "Bold"),
      " formula ",
      katexInline("E=mc^2"),
      " and ",
      relLink
    ),
    el("ul", {}, el("li", {}, "Item ", katexInline("x_0"))),
    el("script", { type: "math/tex" }, "x_0"),
  ]);
  frag.ownerDocument = doc;

  const html = serializer.serializeFragmentHtml(frag, {
    selectionFormat: "plain",
    delimiters: "dollar",
  });

  assert.equal(
    html,
    '<p><strong>Bold</strong> formula $E=mc^2$ and <a href="https://example.com/docs/guide">Guide</a></p><ul><li>Item $x_0$</li></ul>'
  );
});

test("serializer.serializeFragmentHtml converts display math into <p> with <br> line breaks", () => {
  const doc = new MockDocument();
  const frag = new MockFragment([katexDisplay("a^2 + b^2 = c^2")]);
  frag.ownerDocument = doc;

  const html = serializer.serializeFragmentHtml(frag, {
    selectionFormat: "plain",
    delimiters: "dollar",
  });

  assert.equal(html, "<p>$$<br>a^2 + b^2 = c^2<br>$$</p>");
});

test("serializer.serializeFragmentHtml keeps display math inside table cells inline", () => {
  const doc = new MockDocument();
  const frag = new MockFragment([
    el(
      "table",
      {},
      el("tr", {}, el("td", {}, "Pythagoras"), el("td", {}, katexDisplay("a^2 + b^2 = c^2")))
    ),
  ]);
  frag.ownerDocument = doc;

  const html = serializer.serializeFragmentHtml(frag, {
    selectionFormat: "plain",
    delimiters: "dollar",
  });

  assert.equal(
    html,
    "<table><tr><td>Pythagoras</td><td>$a^2 + b^2 = c^2$</td></tr></table>"
  );
});

test("extractors and serializer handle Wikipedia 2026 MathJax SVG + hidden MathML sibling without duplication", () => {
  const doc = new MockDocument();
  const pathNode = el("path", { d: "M0 0" });
  const svgGroup = el("g", { class: "mwe-math-element" }, pathNode);
  const mjxContainer = el(
    "mjx-container",
    { class: "MathJax", jax: "SVG" },
    el("svg", {}, svgGroup)
  );
  const hiddenMathSpan = el(
    "span",
    { style: "display: none" },
    el(
      "math",
      { class: "mwe-math-element" },
      el("semantics", {}, el("annotation", { encoding: "application/x-tex" }, "{\\displaystyle P(A\\mid B)}"))
    )
  );
  const paragraph = el("p", {}, "Bayes: ", hiddenMathSpan, mjxContainer, ".");
  doc.appendChild(paragraph);

  assert.equal(extractors.findMathRoot(pathNode), mjxContainer);
  assert.equal(extractors.findMathRoot(svgGroup), mjxContainer);

  const extracted = extractors.extractMath(pathNode);
  assert.equal(extracted.tex, "P(A\\mid B)");
  assert.equal(extracted.displayMode, false);

  const frag = new MockFragment([paragraph.cloneNode(true)]);
  frag.ownerDocument = doc;
  assert.equal(
    serializer.serializeFragment(frag, { selectionFormat: "plain", delimiters: "dollar" }),
    "Bayes: $P(A\\mid B)$."
  );
  assert.equal(
    serializer.serializeFragmentHtml(frag, { selectionFormat: "plain", delimiters: "dollar" }),
    "<p>Bayes: $P(A\\mid B)$.</p>"
  );
});

test("extractors and serializer handle live Wikipedia data-mw MathJax SVG (no annotation) and unscrolled mjx-lazy", () => {
  const doc = new MockDocument();
  const dataMwInline = JSON.stringify({
    name: "math",
    attrs: {},
    body: { extsrc: "P(A\\vert B) = \\frac{P(B \\vert A) P(A)}{P(B)}" },
  });
  const dataMwBlock = JSON.stringify({
    name: "math",
    attrs: { display: "block" },
    body: { extsrc: "P(A \\cap B) = P(A\\vert B) P(B)." },
  });

  // 1. Scrolled live Wikipedia equation: hidden span.mwe-math-mathml-a11y + mjx-container > svg
  const svgPath = el("path", { d: "M0 0" });
  const mjxScrolled = el("mjx-container", { class: "MathJax", jax: "SVG" }, el("svg", {}, svgPath));
  const a11ySpan = el(
    "span",
    { class: "mwe-math-mathml-a11y", style: "display: none;" },
    el("math", { class: "mwe-math-element mwe-math-element-inline mathjax_ignore", "data-mw": dataMwInline }, el("mrow", {}, el("mi", {}, "P")))
  );
  const pScrolled = el("p", {}, "Formula: ", a11ySpan, mjxScrolled, ".");
  doc.appendChild(pScrolled);

  assert.equal(extractors.findMathRoot(svgPath), mjxScrolled);
  const scrolledRes = extractors.extractMath(svgPath);
  assert.equal(scrolledRes.tex, "P(A\\vert B) = \\frac{P(B \\vert A) P(A)}{P(B)}");
  assert.equal(scrolledRes.displayMode, false);

  const scrolledFrag = new MockFragment([pScrolled.cloneNode(true)]);
  scrolledFrag.ownerDocument = doc;
  assert.equal(
    serializer.serializeFragment(scrolledFrag, { selectionFormat: "plain", delimiters: "dollar" }),
    "Formula: $P(A\\vert B) = \\frac{P(B \\vert A) P(A)}{P(B)}$."
  );

  // 2. Unscrolled live Wikipedia equation: visible <math data-mw> + <mjx-container><mjx-lazy>
  const mathMi = el("mi", {}, "P");
  const unscrolledMath = el(
    "math",
    { class: "mwe-math-element mwe-math-element-block", display: "block", "data-mw": dataMwBlock },
    el("mrow", {}, mathMi)
  );
  const lazyMjx = el("mjx-container", {}, el("mjx-lazy", { "data-mjx-lazy": "10" }));
  const pUnscrolled = el("p", {}, unscrolledMath, lazyMjx);
  doc.appendChild(pUnscrolled);

  assert.equal(extractors.findMathRoot(mathMi), unscrolledMath);
  assert.equal(extractors.extractMath(lazyMjx), null);
  const unscrolledRes = extractors.extractMath(mathMi);
  assert.equal(unscrolledRes.tex, "P(A \\cap B) = P(A\\vert B) P(B).");
  assert.equal(unscrolledRes.displayMode, true);

  const unscrolledFrag = new MockFragment([pUnscrolled.cloneNode(true)]);
  unscrolledFrag.ownerDocument = doc;
  assert.equal(
    serializer.serializeFragment(unscrolledFrag, { selectionFormat: "plain", delimiters: "dollar" }),
    "$$\nP(A \\cap B) = P(A\\vert B) P(B).\n$$"
  );
});


test("Ctrl+C leaves copies without maths, and copies inside editors, untouched", () => {
  // Load content.js against a fake page with just enough of window/document to run its copy handler.
  const listeners = {};
  let selection = null;
  const doc = new MockDocument();
  Object.assign(doc, { addEventListener() {}, dispatchEvent() {}, documentElement: null });
  globalThis.window = {
    addEventListener(type, fn) {
      listeners[type] = fn;
    },
    getSelection: () => selection,
  };
  globalThis.document = doc;
  try {
    require("../src/content.js");

    const selectionOf = (container) => {
      const text = container.childNodes[0];
      const range = {
        startContainer: text,
        endContainer: container.childNodes[container.childNodes.length - 1],
        commonAncestorContainer: container,
        intersectsNode: () => true,
        cloneRange() {
          return { ...this, setStartBefore() {}, setEndAfter() {} };
        },
        cloneContents: () => new MockFragment(container.childNodes.map((c) => c.cloneNode(true))),
      };
      return { isCollapsed: false, rangeCount: 1, anchorNode: text, focusNode: text, getRangeAt: () => range };
    };
    const copy = (target) => {
      const event = {
        target,
        data: {},
        prevented: false,
        stopped: false,
        clipboardData: { setData: (type, value) => (event.data[type] = value) },
        preventDefault: () => (event.prevented = true),
        stopImmediatePropagation: () => (event.stopped = true),
      };
      listeners.copy(event);
      return event;
    };

    // Plain text: the page's own copy runs as normal.
    const plain = el("p", {}, "Just some words.");
    selection = selectionOf(plain);
    const untouched = copy(plain);
    assert.deepEqual([untouched.data, untouched.prevented, untouched.stopped], [{}, false, false]);

    // Maths inside a text box is the editor's business.
    const box = el("textarea", {}, "Let ", katexInline("x"));
    selection = selectionOf(box);
    const inEditor = copy(box);
    assert.deepEqual([inEditor.data, inEditor.prevented, inEditor.stopped], [{}, false, false]);

    // Maths in normal text is converted, and the page's handlers are stopped.
    const withMaths = el("p", {}, "Let ", katexInline("x^2"), " be positive.");
    selection = selectionOf(withMaths);
    const converted = copy(withMaths);
    assert.equal(converted.data["text/plain"], "Let $x^2$ be positive.");
    assert.ok(converted.data["text/html"].includes("$x^2$"));
    assert.deepEqual([converted.prevented, converted.stopped], [true, true]);
  } finally {
    delete globalThis.window;
    delete globalThis.document;
  }
});

test("Wikipedia {{math}} / {{mvar}} HTML (span.texhtml) is rebuilt as LaTeX", () => {
  const tx = (...children) => el("span", { class: "texhtml " }, ...children);
  const sfrac = (num, den) =>
    el("span", { class: "sfrac" }, el("span", {}, "\u2060"),
      el("span", { class: "tion" }, el("span", { class: "num" }, ...num), el("span", { class: "sr-only" }, "/"), el("span", { class: "den" }, ...den)),
      el("span", {}, "\u2060"));
  const cases = [
    [tx(el("i", {}, "ε"), el("sub", {}, "0")), "\\varepsilon_0"],
    [tx(el("b", {}, "E")), "\\mathbf{E}"],
    [el("span", { class: "texhtml mvar", style: "font-style:italic;" }, "ρ"), "\\rho"],
    [tx("∇×"), "\\nabla\\times"],
    [tx("d", el("i", {}, "V")), "dV"],
    [tx("Φ", el("sub", {}, el("i", {}, "B"))), "\\Phi_B"],
    [tx(el("i", {}, "k"), el("sub", {}, "B")), "k_B"],
    [tx(el("i", {}, "m"), el("sub", {}, "u"), " ≠ ", el("i", {}, "σ"), " = 0 ± 1"), "m_u \\neq \\sigma = 0 \\pm 1"],
    [tx("sinc(x) = log", el("sub", {}, "2"), " x"), "\\mathrm{sinc}(x) = \\log_2 x"],
    [tx(el("i", {}, "a"), el("sup", {}, "2"), " + ", el("i", {}, "b"), el("sup", {}, "2"), " = ", el("i", {}, "c"), el("sup", {}, "2")), "a^2 + b^2 = c^2"],
    [tx(el("b", {}, "E"), " = ", el("b", {}, "E"), el("sub", {}, "0"), " sin(−", el("i", {}, "ωt"), " + ", el("b", {}, "k"), " ⋅ ", el("b", {}, "r"), ")"),
      "\\mathbf{E} = \\mathbf{E}_0 \\sin(-\\omega t + \\mathbf{k} \\cdot \\mathbf{r})"],
    [tx("2", el("sup", {}, "2", el("sup", {}, el("i", {}, "n"))), el("span", {}, "\u00a0"), "+", el("span", {}, "\u00a0"), "1"), "2^{2^n} + 1"],
    [tx(el("i", {}, "β"), el("sub", {}, "1"), " = ", el("strong", { class: "error" }, "Page Template:Sfrac/styles.css has no content."), sfrac(["1"], [el("i", {}, "K"), el("sub", {}, "2")])),
      "\\beta_1 = \\frac{1}{K_2}"],
    [tx(el("b", {}, "γ"), " = (", el("i", {}, "γ"), el("sup", {}, "1"), ", …)"), "\\boldsymbol{\\gamma} = (\\gamma^1, \\ldots)"],
    [tx(el("b", {}, "E′"), " = ", el("b", {}, "E"), " + ", el("b", {}, "v"), " × ", el("b", {}, "B")), "\\mathbf{E'} = \\mathbf{E} + \\mathbf{v} \\times \\mathbf{B}"],
    [tx("{", el("i", {}, "s"), " ∈ ", el("math", { class: "mwe-math-element", alttext: "{\\displaystyle \\mathbb {C} }" }, el("mi", {}, "ℂ")), " | Re(", el("i", {}, "s"), ") = 1/2}"),
      "\\{s \\in {\\mathbb {C}} | \\operatorname{Re}(s) = 1/2\\}"],
  ];
  cases.push(
    [tx(el("i", {}, "f̂"), "(", el("i", {}, "ξ"), ")"), "\\hat{f}(\\xi)"],
    [tx(el("span", {}, "⌊"), el("i", {}, "x"), el("span", {}, "⌋")), "\\lfloor x\\rfloor"]
  );
  for (const [node, tex] of cases) {
    const res = extractors.extractMath(node);
    assert.equal(res?.tex, tex);
    assert.equal(res.displayMode, false);
  }

  // Markup it can't map (Fourier transform's stacked-hat trick) stays plain text, not half-converted.
  const hat = tx(el("span", { class: "sfrac nowrap;" }, el("span", {}, el("span", {}, "＾"), el("span", {}, el("i", {}, "f")))));
  assert.equal(extractors.findMathRoot(hat), null);
  assert.equal(extractors.extractMath(hat), null);

  // Selection copy, and hover/click (findMathRoot from inside the span), both see it.
  const eps = tx(el("i", {}, "ε"), el("sub", {}, "0"));
  assert.equal(extractors.findMathRoot(eps.childNodes[0].childNodes[0]), eps);
  assert.equal(
    serializer.serializeFragment(new MockFragment([el("p", {}, "the permittivity of free space, ", eps, ", and")]), { selectionFormat: "plain", delimiters: "dollar" }),
    "the permittivity of free space, $\\varepsilon_0$, and"
  );

  // Turning the setting off makes these spans ordinary text again, for every copy path.
  extractors.options.wikiInlineSymbols = false;
  try {
    assert.equal(extractors.findMathRoot(eps), null);
    assert.equal(extractors.extractMath(eps), null);
  } finally {
    extractors.options.wikiInlineSymbols = true;
  }
  assert.equal(defaults.DEFAULTS.wikiInlineSymbols, true);
});

test("Wikidata-linked Wikipedia equations read their TeX from the element sharing their about id", () => {
  // Harmonic oscillator: <math qid=…> puts data-mw on a separate span; the <math> only has about=.
  const doc = new MockDocument();
  const holder = el("span", {
    about: "#mwt40",
    typeof: "mw:Extension/math",
    "data-mw": JSON.stringify({ name: "math", attrs: { display: "block", qid: "Q834020" }, body: { extsrc: "\\omega = \\sqrt{\\frac k m}." } }),
  });
  const math = el("math", { class: "mwe-math-element mwe-math-element-block", display: "block", about: "#mwt40" }, el("mi", {}, "ω"));
  const mjx = el("mjx-container", { class: "MathJax" }, el("mjx-lazy", {}));
  const p = el("p", {}, "The angular frequency is ", el("span", { class: "mwe-math-mathml-a11y", style: "display: none;" }, math), mjx);
  doc.appendChild(holder);
  doc.appendChild(p);

  assert.equal(extractors.findMathRoot(math), math);
  assert.deepEqual(
    { tex: extractors.extractMath(mjx).tex, displayMode: extractors.extractMath(mjx).displayMode },
    { tex: "\\omega = \\sqrt{\\frac k m}.", displayMode: true }
  );
  // A copied fragment keeps the about id and still finds the TeX in the page.
  const frag = new MockFragment([p.cloneNode(true)]);
  frag.ownerDocument = doc;
  assert.equal(
    serializer.serializeFragment(frag, { selectionFormat: "plain", delimiters: "dollar" }),
    "The angular frequency is\n\n$$\n\\omega = \\sqrt{\\frac k m}.\n$$"
  );
});

test("Wikipedia {{oiint}} (integral-sign image between <math> pieces) copies as one equation", () => {
  // Trimmed from Gauss's law: a11y <math> pieces, MathJax containers and the ∯ image.
  const wikiMath = (tex) =>
    el("span", { class: "mwe-math-mathml-a11y", style: "display: none;" },
      el("math", { class: "mwe-math-element mwe-math-element-inline", "data-mw": JSON.stringify({ name: "math", attrs: {}, body: { extsrc: tex } }) }, el("mi", {}, "x")));
  const sign = () => el("span", { class: "skin-invert" }, el("img", { alt: "\\oiint", src: "OiintLaTeX.svg.png" }));
  const shifted = (...kids) => el("span", { style: "position:relative; right:8px; top:18px; margin-right:-8px;" }, ...kids);
  const sub = wikiMath("\\scriptstyle _S");
  const integral = el("span", { class: "nowrap" },
    wikiMath("\\Phi_E = "), el("mjx-container", {}),
    " ", sign(),
    shifted(sub, el("mjx-container", {})),
    " ", wikiMath("\\mathbf{E} \\cdot \\mathrm{d}\\mathbf{A}"), el("mjx-container", {}));
  const dl = el("dl", {}, el("dd", {}, integral));

  // Hovering any piece picks the whole equation.
  assert.equal(extractors.findMathRoot(sub.childNodes[0]), integral);
  assert.deepEqual(
    { tex: extractors.extractMath(integral).tex, displayMode: extractors.extractMath(integral).displayMode },
    { tex: "\\Phi_E = \\oiint_S \\mathbf{E} \\cdot \\mathrm{d}\\mathbf{A}", displayMode: true }
  );
  assert.equal(
    serializer.serializeFragment(new MockFragment([dl]), { selectionFormat: "markdown", delimiters: "dollar" }),
    "$$\n\\Phi_E = \\oiint_S \\mathbf{E} \\cdot \\mathrm{d}\\mathbf{A}\n$$"
  );

  // Nested in another template (Gauss's law proof): no preintegral, a braced subscript with no
  // underscore marker of its own handled by position, and the equation continuing after the integrand.
  const nested = el("span", { class: "nowrap" }, " ", sign(),
    shifted(wikiMath("{\\scriptstyle S}")), " ", wikiMath("\\mathbf{E} \\cdot \\mathrm{d}\\mathbf{A}"), wikiMath(" = \\frac{Q}{\\varepsilon_0}"));
  assert.equal(extractors.extractMath(nested).tex, "\\oiint_{S} \\mathbf{E} \\cdot \\mathrm{d}\\mathbf{A} = \\frac{Q}{\\varepsilon_0}");

  // Maxwell's equations: {{oiint}} on its own, its subscript and integrand in the next <math> after an
  // invisible \vphantom integral. The two copy as one equation, in text and in HTML.
  const lead = el("span", { class: "nowrap" }, " ", sign(), shifted(), " ");
  const para = el("p", {}, "where ", lead,
    wikiMath("{\\vphantom{\\oint}}_{\\scriptstyle\\partial \\Omega}\\mathbf{E}\\cdot\\mathrm{d}\\mathbf{S} = 0"), el("mjx-container", {}), " holds");
  const joined = "where $\\oiint_{\\partial \\Omega}\\mathbf{E}\\cdot\\mathrm{d}\\mathbf{S} = 0$ holds";
  assert.equal(serializer.serializeFragment(new MockFragment([para]), { selectionFormat: "plain", delimiters: "dollar" }), joined);
  const htmlFrag = new MockFragment([para.cloneNode(true)]);
  htmlFrag.ownerDocument = new MockDocument();
  const html = serializer.serializeFragmentHtml(htmlFrag, { selectionFormat: "plain", delimiters: "dollar" });
  assert.ok(html.includes(joined) && !html.includes("OiintLaTeX"), html);

  // Plain text between the pieces can't be rebuilt safely: the pieces copy separately, as before.
  const mixed = el("span", { class: "nowrap" }, sign(), " for all ", wikiMath("x"));
  assert.equal(extractors.extractMath(mixed), null);
  assert.equal(extractors.findMathRoot(mixed), null);

  // Inside {{math}}, MathJax's rendering of a nested equation is skipped in favour of its hidden TeX.
  const zeta = el("span", { class: "texhtml " }, "{", el("i", {}, "s"), " ∈ ", wikiMath("\\mathbb{C}"), el("mjx-container", {}), " | 0 < Re(", el("i", {}, "s"), ") < 1}");
  assert.equal(extractors.extractMath(zeta).tex, "\\{s \\in {\\mathbb{C}} | 0 < \\operatorname{Re}(s) < 1\\}");
});

test("text the page hides from copying ([edit] links, collapsed boxes) is left out, as in the browser's own copy", () => {
  const doc = new MockDocument();
  // Stylesheet rules, by class. The maths root is user-select: none too, and must still copy.
  const hiddenBy = { "mw-editsection": { userSelect: "none" }, "mw-collapsed": { display: "none" }, katex: { userSelect: "none" } };
  doc.defaultView = {
    getComputedStyle: (node) => ({ display: "inline", userSelect: "auto", ...hiddenBy[node.className] }),
  };
  const editLink = el("span", { class: "mw-editsection" }, "[edit]");
  const page = el(
    "div",
    {},
    el("h2", {}, "Gauss's law", editLink),
    el("p", {}, "Let ", katexInline("x^2"), " be positive."),
    el("div", { class: "mw-collapsed" }, "Authority control")
  );
  Object.assign(page, { ownerDocument: doc, isConnected: true });
  const range = {
    startContainer: page,
    endContainer: page,
    commonAncestorContainer: page,
    intersectsNode: () => true,
    cloneRange() {
      return { ...this, setStartBefore() {}, setEndAfter() {} };
    },
    cloneContents: () => new MockFragment(page.childNodes.map((c) => c.cloneNode(true))),
  };
  const selection = { isCollapsed: false, rangeCount: 1, getRangeAt: () => range };
  const out = serializer.serializeSelection(selection, { selectionFormat: "plain", delimiters: "dollar" }, { skipSync: true });
  assert.equal(out, "Gauss's law\n\nLet $x^2$ be positive.");

  // Navboxes: rows collapsed with hidden="until-found" are left out, and a nested table's rows aren't copied twice.
  const navbox = el(
    "table",
    {},
    el(
      "tbody",
      {},
      el("tr", {}, el("th", {}, "Electromagnetism")),
      el("tr", { hidden: "until-found" }, el("td", {}, "BnF data")),
      el("tr", {}, el("td", {}, el("table", {}, el("tbody", {}, el("tr", {}, el("td", {}, "Gauss's law"))))))
    )
  );
  assert.equal(
    serializer.serializeFragment(new MockFragment([navbox]), { selectionFormat: "plain", delimiters: "dollar" }),
    "Electromagnetism\nGauss's law"
  );
  // The live page is left as it was.
  assert.equal(editLink.hasAttribute("data-mathsclip-skip"), false);
});
