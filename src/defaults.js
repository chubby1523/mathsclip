/**
 * Shared default settings, formatting utilities, and chrome.storage helpers.
 * Uses globalThis.CopyMath so it runs identically in classic content scripts,
 * MV3 service workers (importScripts), popup scripts, and Node.js tests.
 */
(function initDefaults(root) {
  const CopyMath = (root.CopyMath = root.CopyMath || {});

  const DEFAULTS = Object.freeze({
    interceptCopy: true,
    contextMenuEnabled: true,
    overrideMathJaxMenu: false,
    clickToCopy: false,
    selectionFormat: "plain", // "plain" | "markdown"
    delimiters: "dollar", // "dollar" ($...$ / $$...$$) | "parens" (\(...\) / \[...\])
    singleEquationWrap: "raw", // "raw" | "delimited"
    showToast: true,
  });

  const DELIMITER_PAIRS = Object.freeze({
    dollar: {
      inline: ["$", "$"],
      display: ["$$", "$$"],
    },
    parens: {
      inline: ["\\(", "\\)"],
      display: ["\\[", "\\]"],
    },
  });

  /**
   * Formats extracted TeX according to display mode, delimiter style, and wrap mode.
   * @param {string} tex
   * @param {boolean} displayMode
   * @param {"dollar"|"parens"} delimiterStyle
   * @param {"raw"|"delimited"} wrapMode
   * @returns {string}
   */
  function formatTex(tex, displayMode, delimiterStyle, wrapMode) {
    const cleaned = String(tex || "").trim();
    if (!cleaned) return "";
    if (wrapMode === "raw") return cleaned;

    const pair = DELIMITER_PAIRS[delimiterStyle] || DELIMITER_PAIRS.dollar;
    // Multi-line TeX breaks inline $...$ parsers in Markdown, so promote to block delimiters.
    if (displayMode || cleaned.includes("\n")) {
      const [open, close] = pair.display;
      return `${open}\n${cleaned}\n${close}`;
    }
    const [open, close] = pair.inline;
    return `${open}${cleaned}${close}`;
  }

  /**
   * Reads persisted extension settings merged with DEFAULTS.
   * @returns {Promise<typeof DEFAULTS>}
   */
  async function getSettings() {
    if (typeof chrome === "undefined" || !chrome.storage?.sync) {
      return { ...DEFAULTS };
    }
    try {
      const items = await chrome.storage.sync.get(DEFAULTS);
      return { ...DEFAULTS, ...(items || {}) };
    } catch {
      return { ...DEFAULTS };
    }
  }

  /**
   * Saves a partial settings object to chrome.storage.sync.
   * @param {Partial<typeof DEFAULTS>} patch
   * @returns {Promise<void>}
   */
  async function saveSettings(patch) {
    if (typeof chrome === "undefined" || !chrome.storage?.sync) {
      return;
    }
    try {
      await chrome.storage.sync.set(patch);
    } catch {
      // Ignore storage write errors (e.g. quota or disconnected context).
    }
  }

  CopyMath.DEFAULTS = DEFAULTS;
  CopyMath.DELIMITER_PAIRS = DELIMITER_PAIRS;
  CopyMath.formatTex = formatTex;
  CopyMath.getSettings = getSettings;
  CopyMath.saveSettings = saveSettings;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      DEFAULTS,
      DELIMITER_PAIRS,
      formatTex,
      getSettings,
      saveSettings,
    };
  }
})(typeof globalThis !== "undefined" ? globalThis : window);
