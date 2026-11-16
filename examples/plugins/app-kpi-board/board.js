// KPI board: an example app page for Kalzit (docs/api/plugins.md, "App plugins").
// It runs in a sandboxed frame without network and talks to Kalzit's page around it only through
// the app message API, version 1: it asks for the dashboards the person may read and keeps one
// note per dashboard in the app's own storage.

const API = 1;
let next = 1;
const waiting = new Map();

function ask(type, payload) {
  const id = next++;
  window.parent.postMessage({ kalzit: "app", api: API, type, id, ...payload }, "*");
  return new Promise((resolve, reject) => waiting.set(id, { resolve, reject }));
}

window.addEventListener("message", (event) => {
  if (event.source !== window.parent) return;
  const message = event.data;
  if (!message || message.kalzit !== "app" || message.api !== API) return;
  const pending = waiting.get(message.replyTo);
  if (!pending) return;
  waiting.delete(message.replyTo);
  if (message.error) pending.reject(new Error(message.error.message));
  else pending.resolve(message.result);
});

function text(tag, content) {
  const el = document.createElement(tag);
  el.textContent = content;
  return el;
}

async function render() {
  document.body.replaceChildren(text("p", "…"));
  const dashboards = await ask("dashboards.list", {});
  const list = document.createElement("ul");
  for (const dashboard of dashboards.items) {
    const item = document.createElement("li");
    item.append(text("strong", dashboard.title));
    const note = document.createElement("input");
    note.setAttribute("aria-label", dashboard.title);
    const stored = await ask("storage.get", { key: `note:${dashboard.id}` }).catch(() => null);
    note.value = stored?.value ?? "";
    note.addEventListener("change", () => ask("storage.put", { key: `note:${dashboard.id}`, value: note.value }));
    item.append(" ", note);
    list.append(item);
  }
  document.body.replaceChildren(list);
}

window.parent.postMessage({ kalzit: "app", api: API, type: "ready" }, "*");
render().catch((e) => document.body.replaceChildren(text("p", e.message)));