// Runs as a classic, render-blocking script before the stylesheet applies, so a stored dark or
// high-contrast theme, or a stored light or dark variant, never flashes another one on load. Kept
// as a file (not inline) for the CSP. The app takes over in src/theme/theme.ts; the storage keys
// must match the ones there.
(() => {
  const themes = ["system", "light", "dark", "contrast"];
  // The variant of each side, which "System", Light and Dark show (tokens.css, data-light and
  // data-dark); the lists and keys match LIGHT_VARIANTS and DARK_VARIANTS there.
  const lightVariants = ["light", "paper", "calcite"];
  const darkVariants = ["dark", "graphite", "night"];
  const read = (key, allowed, fallback) => {
    try {
      const stored = window.localStorage.getItem(key);
      return allowed.includes(stored) ? stored : fallback;
    } catch {
      // Storage blocked: fall back to the default.
      return fallback;
    }
  };
  // The pages before sign-in (PRE_SIGN_IN_PATHS there) show the server's default variants as last
  // seen, never the variant an account stored, which is chosen only in the account settings.
  const preSignInPaths = [
    "/login",
    "/anmelden",
    "/setup",
    "/invite",
    "/reset-password",
    "/register",
    "/confirm-email",
  ];
  const base = document.querySelector('meta[name="kalzit-base-path"]')?.getAttribute("content");
  let path = window.location.pathname;
  if (base && /^(\/[A-Za-z0-9._~-]+)+$/.test(base) && path.startsWith(base)) {
    path = path.slice(base.length) || "/";
  }
  const preSignIn = preSignInPaths.some((page) => path === page || path.startsWith(`${page}/`));
  const root = document.documentElement;
  root.dataset.theme = read("kalzit.theme", themes, "system");
  root.dataset.light = preSignIn
    ? read("kalzit.defaultThemeLight", lightVariants, "light")
    : read("kalzit.themeLight", lightVariants, "light");
  root.dataset.dark = preSignIn
    ? read("kalzit.defaultThemeDark", darkVariants, "dark")
    : read("kalzit.themeDark", darkVariants, "dark");
  // The look an admin chose (accent, density, font size), as src/appearance/look.ts last applied
  // it; the app checks and applies it again once it loads.
  try {
    const look = JSON.parse(window.localStorage.getItem("kalzit.look") || "{}");
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
