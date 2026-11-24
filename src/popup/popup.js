(function initPopup() {
  const { getSettings, saveSettings } = globalThis.CopyMath;

  const TOGGLE_KEYS = [
    "interceptCopy",
    "contextMenuEnabled",
    "overrideMathJaxMenu",
    "clickToCopy",
    "showToast",
  ];

  const RADIOS = document.querySelectorAll('input[type="radio"]');

  async function hydrate() {
    try {
      const settings = await getSettings();

      for (const key of TOGGLE_KEYS) {
        const input = document.getElementById(key);
        if (input) {
          input.checked = Boolean(settings[key]);
        }
      }

      for (const radio of RADIOS) {
        radio.checked = settings[radio.name] === radio.value;
      }
    } catch {
      // Ignore storage load errors in popup initialization.
    }
  }

  for (const key of TOGGLE_KEYS) {
    const input = document.getElementById(key);
    if (!input) continue;
    input.addEventListener("change", async () => {
      try {
        await saveSettings({ [key]: input.checked });
      } catch {
        // Ignore storage write errors.
      }
    });
  }

  for (const radio of RADIOS) {
    radio.addEventListener("change", async () => {
      try {
        await saveSettings({ [radio.name]: radio.value });
      } catch {
        // Ignore storage write errors.
      }
    });
  }

  void hydrate();
})();
