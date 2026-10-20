// Runs as a classic, render-blocking script before the stylesheet applies, so a stored dark or
// high-contrast theme never flashes light on load. Kept as a file (not inline) for the CSP. The app
// takes over in src/theme/theme.ts; the storage key must match THEME_STORAGE_KEY there.
(() => {
  const themes = ["system", "light", "dark", "contrast"];
  let theme = "system";
  try {
    const stored = window.localStorage.getItem("kalzit.theme");
    if (themes.includes(stored)) {
      theme = stored;
    }
  } catch {
    // Storage blocked: fall back to the system theme.
  }
  document.documentElement.dataset.theme = theme;
})();
