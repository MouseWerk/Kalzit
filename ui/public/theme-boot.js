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
  // The look an admin chose (accent, density, font size), as src/appearance/look.ts last applied
  // it; the app checks and applies it again once it loads.
  try {
    const look = JSON.parse(window.localStorage.getItem("kalzit.look") || "{}");
    const root = document.documentElement;
    if (/^[a-z]+$/.test(look.accent)) {
      root.dataset.accent = look.accent;
    }
    if (/^(compact|balanced|comfortable)$/.test(look.density)) {
      root.dataset.density = look.density;
    }
    if ([13, 14, 15, 16].includes(look.fontSize)) {
      root.dataset.fontSize = String(look.fontSize);
    }
  } catch {
    // Storage blocked or nothing stored: the default look.
  }
})();
