/**
 * Manifest V3 background service worker.
 * Manages right-click context menus and routes menu clicks to the active tab/frame.
 */
importScripts("defaults.js");

const MENU_SELECTION_ID = "copy-math-selection";
const MENU_EQUATION_ID = "copy-math-equation";

let rebuildQueue = Promise.resolve();

async function rebuildContextMenus() {
  try {
    const settings = await CopyMath.getSettings();

    await new Promise((resolve) => {
      chrome.contextMenus.removeAll(() => {
        void chrome.runtime?.lastError;
        resolve();
      });
    });

    if (!settings.contextMenuEnabled) return;

    const selectionTitle =
      settings.selectionFormat === "markdown"
        ? "Copy Selection as Markdown + LaTeX"
        : "Copy Selection with LaTeX";

    chrome.contextMenus.create(
      {
        id: MENU_SELECTION_ID,
        title: selectionTitle,
        contexts: ["selection"],
      },
      () => {
        void chrome.runtime?.lastError;
      }
    );

    chrome.contextMenus.create(
      {
        id: MENU_EQUATION_ID,
        title: "Copy Equation as LaTeX",
        contexts: ["page", "frame", "image", "link"],
      },
      () => {
        void chrome.runtime?.lastError;
      }
    );
  } catch {
    // Prevent unexpected contextMenus errors from poisoning future rebuilds.
  }
}

function syncContextMenus() {
  const prev = rebuildQueue;
  rebuildQueue = (async () => {
    await prev;
    await rebuildContextMenus();
  })();
  return rebuildQueue;
}

chrome.runtime.onInstalled.addListener(() => {
  void syncContextMenus();
});

chrome.runtime.onStartup.addListener(() => {
  void syncContextMenus();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync") return;
  if (changes.contextMenuEnabled || changes.selectionFormat) {
    void syncContextMenus();
  }
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab || typeof tab.id !== "number") return;

  const type =
    info.menuItemId === MENU_SELECTION_ID
      ? "COPY_SELECTION"
      : info.menuItemId === MENU_EQUATION_ID
        ? "COPY_EQUATION"
        : null;

  if (!type) return;

  const targetOptions =
    typeof info.frameId === "number" ? { frameId: info.frameId } : undefined;

  try {
    await chrome.tabs.sendMessage(tab.id, { type }, targetOptions);
  } catch {
    // Ignore restricted pages (e.g. chrome://, Web Store) where content scripts cannot run.
  }
});
