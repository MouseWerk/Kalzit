import "./styles/index.css";
// Applies the stored theme and language to <html> before the first render.
import "./theme/theme";
import "./appearance/look";
import "./i18n/i18n";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App, createApp } from "./app/app";

const container = document.getElementById("root");
if (container === null) {
  throw new Error("index.html is missing the #root element");
}

const app = createApp();

createRoot(container).render(
  <StrictMode>
    <App app={app} />
  </StrictMode>,
);
