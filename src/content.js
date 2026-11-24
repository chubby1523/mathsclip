/**
 * Isolated-world content script:
 * 1. Intercepts Ctrl+C / Cmd+C `copy` events when selection contains math.
 * 2. Handles right-click context menu requests (selection or single equation).
 * 3. Provides toggleable Hover + Click-to-Copy UI inside an isolated Shadow DOM.
 */
(function initContent() {
  const { DEFAULTS, formatTex, getSettings, extractors, serializer } =
    globalThis.CopyMath;

  let settings = { ...DEFAULTS };
  let lastRightClickTarget = null;
  let lastRightClickPoint = null;

  // Hover / Click-to-Copy state
  let hoveredMathRoot = null;
  let hoverRafId = 0;
  let resizeRafId = 0;
  let scrollEndTimer = 0;
  let lastPointerEvent = null;
  let pointerDownPos = null;
  let pillLockUntil = 0;

  // Shadow DOM UI references
  let uiHost = null;
  let shadowRoot = null;
  let highlightEl = null;
  let pillEl = null;
  let toastEl = null;
  let toastTimer = 0;

  const UI_CSS = `
    :host {
      all: initial;
      position: fixed;
      inset: 0;
      z-index: 2147483647;
      pointer-events: none;
      contain: layout style paint;
      /* Same palette as the popup. System fonts only: no web fonts are loaded into host pages. */
      color-scheme: light dark;
      --accent: light-dark(#a80000, #ff9999);
      --tip-bg: light-dark(#111111, #f2f2f2);
      --tip-fg: light-dark(#ffffff, #1b1b1d);
      --on-accent: light-dark(#ffffff, #1b1b1d);
      font-family: Georgia, Cambria, "Times New Roman", serif;
    }
    .cm-highlight {
      position: fixed;
      display: none;
      pointer-events: none;
      border: 1.5px solid var(--accent);
      background: color-mix(in srgb, var(--accent) 10%, transparent);
      border-radius: 2px;
      box-sizing: border-box;
    }
    .cm-pill {
      position: fixed;
      display: none;
      pointer-events: none;
      user-select: none;
      background: var(--tip-bg);
      color: var(--tip-fg);
      border: 1px solid transparent;
      border-radius: 2px;
      padding: 2px 8px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 11px;
      line-height: 1.4;
      box-shadow: 0 3px 10px rgba(0, 0, 0, 0.22);
      white-space: nowrap;
    }
    .cm-pill.cm-copied {
      background: var(--accent);
      color: var(--on-accent);
    }
    .cm-toast {
      position: fixed;
      right: 18px;
      bottom: 18px;
      pointer-events: none;
      background: var(--tip-bg);
      color: var(--tip-fg);
      border: 1px solid transparent;
      border-bottom: 2px solid var(--accent);
      border-radius: 2px;
      padding: 7px 11px;
      font-size: 13px;
      font-style: italic;
      box-shadow: 0 6px 18px rgba(0, 0, 0, 0.24);
      opacity: 0;
      transition: opacity 140ms ease;
    }
    @media (prefers-reduced-motion: no-preference) {
      .cm-toast {
        transform: translateY(6px);
        transition: opacity 140ms ease, transform 140ms ease;
      }
      .cm-toast.cm-visible {
        transform: translateY(0);
      }
    }
    .cm-toast.cm-visible {
      opacity: 1;
    }
    .cm-toast.cm-warn {
      background: var(--accent);
      color: var(--on-accent);
      border-bottom-color: var(--tip-bg);
    }
  `;

  function ensureUI() {
    if (uiHost && uiHost.isConnected) return;
    if (!document.documentElement) return;

    uiHost = document.createElement("div");
    uiHost.id = "copy-math-ui-host";
    shadowRoot = uiHost.attachShadow({ mode: "closed" }); // page scripts can't reach in

    const style = document.createElement("style");
    style.textContent = UI_CSS;
    shadowRoot.appendChild(style);

    highlightEl = document.createElement("div");
    highlightEl.className = "cm-highlight";

    pillEl = document.createElement("div");
    pillEl.className = "cm-pill";
    pillEl.setAttribute("role", "status");
    pillEl.setAttribute("aria-live", "polite");
    pillEl.textContent = "Click to copy";

    toastEl = document.createElement("div");
    toastEl.className = "cm-toast";

    shadowRoot.appendChild(highlightEl);
    shadowRoot.appendChild(pillEl);
    shadowRoot.appendChild(toastEl);
    document.documentElement.appendChild(uiHost);
  }

  function showToast(message, isWarn = false) {
    if (!settings.showToast && !isWarn) return;
    ensureUI();
    if (!toastEl) return;

    toastEl.textContent = message;
    toastEl.classList.toggle("cm-warn", Boolean(isWarn));
    toastEl.classList.add("cm-visible");

    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl?.classList.remove("cm-visible");
    }, 1600);
  }

  function hideHoverUI() {
    hoveredMathRoot = null;
    if (highlightEl) highlightEl.style.display = "none";
    if (pillEl) {
      pillEl.style.display = "none";
      pillEl.classList.remove("cm-copied");
      pillEl.textContent = "Click to copy";
    }
  }

  const HIDDEN_A11Y_SELECTOR =
    ".katex-mathml, .mwe-math-mathml-a11y, mjx-assistive-mml";
  const EMPTY_RECT = {
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    width: 0,
    height: 0,
  };

  function getMathBoundingRect(mathRoot) {
    if (!mathRoot || typeof mathRoot.getBoundingClientRect !== "function") {
      return EMPTY_RECT;
    }

    let top = Infinity;
    let left = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;

    const addRect = (r) => {
      if (!r || r.width <= 0 || r.height <= 0) return;
      if (r.width <= 2 && r.height <= 2) return;
      if (r.top < top) top = r.top;
      if (r.left < left) left = r.left;
      if (r.right > right) right = r.right;
      if (r.bottom > bottom) bottom = r.bottom;
    };

    addRect(mathRoot.getBoundingClientRect());

    if (typeof mathRoot.querySelectorAll === "function") {
      const visualEls = mathRoot.querySelectorAll(
        "img, svg, math, .katex-html, .MathJax, .mjx-chtml"
      );
      for (const el of visualEls) {
        if (el.closest?.(HIDDEN_A11Y_SELECTOR)) continue;
        addRect(el.getBoundingClientRect());
      }
    }

    if (!Number.isFinite(top)) return EMPTY_RECT;
    return {
      top,
      left,
      right,
      bottom,
      width: Math.max(0, right - left),
      height: Math.max(0, bottom - top),
    };
  }

  function isPointInRect(point, rect, pad = 3) {
    if (!point || !rect || rect.width <= 0 || rect.height <= 0) return false;
    return (
      point.x >= rect.left - pad &&
      point.x <= rect.right + pad &&
      point.y >= rect.top - pad &&
      point.y <= rect.bottom + pad
    );
  }

  function positionHoverUI(mathRoot) {
    ensureUI();
    if (!highlightEl || !pillEl) return;

    const rect = getMathBoundingRect(mathRoot);
    if (
      rect.width === 0 ||
      rect.height === 0 ||
      rect.bottom <= 0 ||
      rect.top >= window.innerHeight ||
      rect.right <= 0 ||
      rect.left >= window.innerWidth
    ) {
      hideHoverUI();
      return;
    }

    if (Date.now() > pillLockUntil) {
      if (pillEl.classList.contains("cm-copied")) pillEl.classList.remove("cm-copied");
      if (pillEl.textContent !== "Click to copy") pillEl.textContent = "Click to copy";
    }
    if (pillEl.style.display !== "block") {
      pillEl.style.display = "block";
    }

    // Batch layout reads before writing overlay coordinates.
    const pillRect = pillEl.getBoundingClientRect();
    const preferredTop = rect.top - pillRect.height - 6;
    const pillTop =
      preferredTop >= 4
        ? preferredTop
        : Math.min(window.innerHeight - pillRect.height - 4, rect.bottom + 6);
    const pillLeft = Math.max(
      4,
      Math.min(window.innerWidth - pillRect.width - 4, rect.left)
    );

    const pad = 3;
    highlightEl.style.display = "block";
    highlightEl.style.top = `${rect.top - pad}px`;
    highlightEl.style.left = `${rect.left - pad}px`;
    highlightEl.style.width = `${rect.width + pad * 2}px`;
    highlightEl.style.height = `${rect.height + pad * 2}px`;

    pillEl.style.top = `${pillTop}px`;
    pillEl.style.left = `${pillLeft}px`;
  }

  async function writeClipboard(text, html = "") {
    if (!text) return false;

    if (
      html &&
      navigator.clipboard &&
      typeof navigator.clipboard.write === "function" &&
      typeof ClipboardItem === "function"
    ) {
      try {
        await navigator.clipboard.write([
          new ClipboardItem({
            "text/plain": new Blob([text], { type: "text/plain" }),
            "text/html": new Blob([html], { type: "text/html" }),
          }),
        ]);
        return true;
      } catch {
        // Fall back to plain-text clipboard write below.
      }
    }

    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        // Fallback below when document focus/gesture blocks async Clipboard API.
      }
    }

    // Fallback: hidden textarea + execCommand('copy'), preserving current Selection.
    const sel = window.getSelection();
    const savedRanges = [];
    if (sel) {
      for (let i = 0; i < sel.rangeCount; i++) {
        savedRanges.push(sel.getRangeAt(i).cloneRange());
      }
    }

    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.top = "-9999px";
    textarea.style.left = "-9999px";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);

    let ok = false;
    try {
      textarea.select();
      textarea.setSelectionRange(0, text.length);
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    } finally {
      textarea.remove();
      if (sel) {
        sel.removeAllRanges();
        for (const r of savedRanges) {
          sel.addRange(r);
        }
      }
    }
    return ok;
  }

  function findMathAtPoint(point, hintTarget = null) {
    const direct = extractors.findMathRoot(hintTarget);
    if (direct) return direct;
    if (!point) return null;

    const stack = document.elementsFromPoint(point.x, point.y);
    let firstNonHostEl = null;

    for (const el of stack) {
      if (el === uiHost) continue;
      if (!firstNonHostEl) firstNonHostEl = el;
      const root = extractors.findMathRoot(el);
      if (root) return root;
    }

    const hintEl =
      (hintTarget && hintTarget.nodeType === 1
        ? hintTarget
        : hintTarget?.parentElement) || firstNonHostEl;
    const scope =
      hintEl?.closest?.(
        "p, dd, dt, li, td, th, blockquote, h1, h2, h3, h4, h5, h6, figure, figcaption, span"
      ) || hintEl;

    if (
      !scope ||
      scope === document.body ||
      scope === document.documentElement ||
      typeof scope.querySelectorAll !== "function"
    ) {
      return null;
    }

    const seen = new Set();
    let bestRoot = null;
    let bestArea = Infinity;

    const candidates = scope.querySelectorAll(extractors.MATH_ROOT_SELECTOR);
    for (const el of candidates) {
      const root = extractors.findMathRoot(el);
      if (!root || seen.has(root)) continue;
      seen.add(root);

      const rect = getMathBoundingRect(root);
      if (isPointInRect(point, rect, 3)) {
        const area = rect.width * rect.height;
        if (area < bestArea) {
          bestArea = area;
          bestRoot = root;
        }
      }
      if (seen.size >= 60) break;
    }

    if (
      bestRoot === null &&
      hoveredMathRoot &&
      hoveredMathRoot.isConnected &&
      isPointInRect(point, getMathBoundingRect(hoveredMathRoot), 2)
    ) {
      return hoveredMathRoot;
    }

    return bestRoot;
  }

  function isEditableElement(node) {
    if (!node) return false;
    const el =
      node.nodeType === 1 ? node : node.parentElement || null;
    if (!el) return false;
    if (el.isContentEditable) return true;
    if (
      typeof el.closest === "function" &&
      el.closest(
        'input, textarea, select, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]'
      )
    ) {
      return true;
    }
    return false;
  }

  async function copySingleEquation(targetNode, fromPill = false) {
    extractors.requestMainWorldSync();
    const extracted = extractors.extractMath(targetNode);
    if (!extracted) {
      showToast("No equation found under cursor", true);
      return false;
    }

    const formatted = formatTex(
      extracted.tex,
      extracted.displayMode,
      settings.delimiters,
      settings.singleEquationWrap
    );
    const ok = await writeClipboard(formatted);
    if (!ok) {
      showToast("Chrome blocked the clipboard", true);
      return false;
    }

    if (fromPill && pillEl) {
      pillLockUntil = Date.now() + 1200;
      pillEl.textContent = "Copied!";
      pillEl.classList.add("cm-copied");
      setTimeout(() => {
        if (pillEl && Date.now() >= pillLockUntil) {
          pillEl.classList.remove("cm-copied");
          pillEl.textContent = "Click to copy";
        }
      }, 1250);
    } else {
      showToast("Copied LaTeX");
    }
    return true;
  }

  // 1. Intercept native Ctrl+C / Cmd+C / browser Copy when selection contains math.
  // Window capture is the first stop for the event, ahead of page handlers (e.g. Google's own
  // math copy) that would otherwise overwrite our clipboard data.
  window.addEventListener(
    "copy",
    (event) => {
      if (!settings.interceptCopy) return;
      if (isEditableElement(event.target)) {
        return;
      }
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) return;
      if (isEditableElement(sel.anchorNode) || isEditableElement(sel.focusNode)) {
        return;
      }

      extractors.requestMainWorldSync();
      if (!extractors.selectionContainsMath(sel)) return;

      const output = serializer.serializeSelection(sel, settings, { skipSync: true });
      if (!output || !event.clipboardData) return;

      event.clipboardData.setData("text/plain", output);
      if (settings.selectionFormat === "plain") {
        const htmlOutput = serializer.serializeSelectionHtml(sel, settings, {
          skipSync: true,
        });
        if (htmlOutput) {
          event.clipboardData.setData("text/html", htmlOutput);
        }
      }
      event.preventDefault();
      event.stopImmediatePropagation(); // only when we converted maths; other copies pass through
      showToast(
        settings.selectionFormat === "markdown"
          ? "Copied as Markdown + LaTeX"
          : "Copied with LaTeX"
      );
    },
    true
  );

  // 2. Track right-click target and optionally override MathJax's custom context menu
  window.addEventListener(
    "contextmenu",
    (event) => {
      lastRightClickTarget = event.target;
      lastRightClickPoint = { x: event.clientX, y: event.clientY };

      if (!settings.overrideMathJaxMenu) return;
      const mathRoot = findMathAtPoint(lastRightClickPoint, event.target);
      if (mathRoot && extractors.isMathJaxRoot(mathRoot)) {
        extractors.requestMainWorldSync();
        if (extractors.extractMath(mathRoot)) {
          // Block MathJax's custom popup without preventDefault(), letting Chrome's menu open.
          event.stopPropagation();
        }
      }
    },
    true
  );

  // 3. Handle background context menu messages
  if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((msg) => {
      if (!msg || typeof msg.type !== "string") return;

      if (msg.type === "COPY_SELECTION") {
        (async () => {
          try {
            const sel = window.getSelection();
            if (!sel || sel.isCollapsed) return;

            extractors.requestMainWorldSync();
            const hasMath = extractors.selectionContainsMath(sel);
            const output =
              hasMath || settings.selectionFormat === "markdown"
                ? serializer.serializeSelection(sel, settings, { skipSync: true })
                : sel.toString();

            if (output) {
              const htmlOutput =
                hasMath && settings.selectionFormat === "plain"
                  ? serializer.serializeSelectionHtml(sel, settings, { skipSync: true })
                  : "";
              const ok = await writeClipboard(output, htmlOutput);
              if (ok) {
                showToast(
                  settings.selectionFormat === "markdown"
                    ? "Copied as Markdown + LaTeX"
                    : "Copied with LaTeX"
                );
              }
            }
          } catch {
            // Ignore selection copy errors.
          }
        })();
      } else if (msg.type === "COPY_EQUATION") {
        extractors.requestMainWorldSync();
        const target = findMathAtPoint(lastRightClickPoint, lastRightClickTarget);
        if (!target) {
          showToast("No equation found under cursor", true);
          return;
        }
        void copySingleEquation(target, false);
      }
    });
  }

  // 4. Toggleable Hover + Click-to-Copy listeners
  function handleHoverMove() {
    hoverRafId = 0;
    if (!settings.clickToCopy || !lastPointerEvent) {
      hideHoverUI();
      return;
    }

    const { target, clientX, clientY } = lastPointerEvent;
    if (target === uiHost || (uiHost && uiHost.contains(target))) {
      return;
    }
    if (isEditableElement(target)) {
      hideHoverUI();
      return;
    }

    const root = findMathAtPoint({ x: clientX, y: clientY }, target);

    if (!root || isEditableElement(root)) {
      hideHoverUI();
      return;
    }

    if (root !== hoveredMathRoot) {
      extractors.requestMainWorldSync();
      if (!extractors.extractMath(root)) {
        hideHoverUI();
        return;
      }
      hoveredMathRoot = root;
    }
    positionHoverUI(hoveredMathRoot);
  }

  document.addEventListener(
    "mousemove",
    (event) => {
      if (!settings.clickToCopy) return;
      lastPointerEvent = {
        target: event.target,
        clientX: event.clientX,
        clientY: event.clientY,
      };
      if (!hoverRafId) {
        hoverRafId = requestAnimationFrame(handleHoverMove);
      }
    },
    { passive: true }
  );

  document.addEventListener(
    "mousedown",
    (event) => {
      if (!settings.clickToCopy || event.button !== 0) return;
      pointerDownPos = { x: event.clientX, y: event.clientY };
    },
    true
  );

  document.addEventListener(
    "click",
    (event) => {
      if (!settings.clickToCopy || event.button !== 0) return;
      if (event.target === uiHost || (uiHost && uiHost.contains(event.target))) {
        return;
      }
      if (isEditableElement(event.target)) return;

      // Only trigger click-to-copy on genuine clicks, not drag-selections.
      if (pointerDownPos) {
        const dx = Math.abs(event.clientX - pointerDownPos.x);
        const dy = Math.abs(event.clientY - pointerDownPos.y);
        if (dx > 5 || dy > 5) return;
      }

      const root = findMathAtPoint({ x: event.clientX, y: event.clientY }, event.target);
      if (!root || isEditableElement(root)) return;

      // A selection elsewhere (e.g. shift-click extending one) isn't a copy click. A selection
      // of this equation is: KaTeX's copy-tex.css sets user-select: all, so a click selects it.
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed && !sel.containsNode(root, true)) return;

      extractors.requestMainWorldSync();
      if (!extractors.extractMath(root)) return;

      event.preventDefault();
      event.stopPropagation();
      hoveredMathRoot = root;
      positionHoverUI(root);
      void copySingleEquation(root, true);
    },
    true
  );

  function onScrollRest() {
    clearTimeout(scrollEndTimer);
    scrollEndTimer = 0;
    if (!settings.clickToCopy || !lastPointerEvent) return;
    // Refresh target at current pointer coordinates once scrolling settles.
    lastPointerEvent = {
      target: document.elementFromPoint(lastPointerEvent.clientX, lastPointerEvent.clientY),
      clientX: lastPointerEvent.clientX,
      clientY: lastPointerEvent.clientY,
    };
    if (!hoverRafId) {
      hoverRafId = requestAnimationFrame(handleHoverMove);
    }
  }

  window.addEventListener(
    "scroll",
    () => {
      if (!settings.clickToCopy) return;
      if (hoveredMathRoot) hideHoverUI();
      if (!lastPointerEvent) return;
      clearTimeout(scrollEndTimer);
      scrollEndTimer = setTimeout(onScrollRest, 120);
    },
    { passive: true, capture: true }
  );

  if ("onscrollend" in window) {
    window.addEventListener("scrollend", onScrollRest, {
      passive: true,
      capture: true,
    });
  }

  window.addEventListener(
    "resize",
    () => {
      if (!settings.clickToCopy || !hoveredMathRoot || resizeRafId) return;
      resizeRafId = requestAnimationFrame(() => {
        resizeRafId = 0;
        if (!hoveredMathRoot?.isConnected) {
          hideHoverUI();
          return;
        }
        positionHoverUI(hoveredMathRoot);
      });
    },
    { passive: true }
  );

  const clearHoverState = () => {
    lastPointerEvent = null;
    clearTimeout(scrollEndTimer);
    scrollEndTimer = 0;
    if (hoveredMathRoot) hideHoverUI();
  };

  if (document.documentElement) {
    document.documentElement.addEventListener("mouseleave", clearHoverState, {
      passive: true,
    });
  }

  window.addEventListener("blur", clearHoverState, { passive: true });

  document.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Escape" && hoveredMathRoot) {
        hideHoverUI();
      }
    },
    { passive: true }
  );

  // 5. Load settings & react immediately to popup changes
  async function loadInitialSettings() {
    try {
      const loaded = await getSettings();
      settings = loaded;
      if (!settings.clickToCopy) hideHoverUI();
    } catch {
      // Keep default settings on failure.
    }
  }
  void loadInitialSettings();

  if (typeof chrome !== "undefined" && chrome.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "sync") return;
      for (const [key, change] of Object.entries(changes)) {
        settings[key] = change.newValue;
      }
      if (!settings.clickToCopy) {
        hideHoverUI();
      }
    });
  }
})();
