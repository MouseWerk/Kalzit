import "./styles/index.css";
// Applies the stored theme and language to <html> before the first render.
import "./theme/theme";
import "./appearance/look";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App, createApp } from "./app/app";
import { loadInitialLanguage, loadLanguage } from "./i18n/i18n";
import { removeRetiredPreferences } from "./lib/storage";

const container = document.getElementById("root");
if (container === null) {
  throw new Error("index.html is missing the #root element");
}

removeRetiredPreferences();
const app = createApp();
const root = createRoot(container);

function render() {
  root.render(
    <StrictMode>
      <App app={app} />
    </StrictMode>,
  );
}

// Only the language the page starts in is fetched (its own chunk); the first render waits for it,
// so no text ever shows as its key. Should that fetch fail, English is tried, and the page renders
// in any case rather than staying blank.
loadInitialLanguage()
  .catch(() => loadLanguage("en"))
  .then(render, render);
