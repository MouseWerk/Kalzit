/** Documents whose CodeMirror style element is already found (and mirrored when blocked). */
const handled = new WeakSet<Document>();

/**
 * Runs `mount`, which creates a CodeMirror editor, and keeps the editor's styles working under the
 * server's Content-Security-Policy. CodeMirror writes its base styles and theme into one `<style>`
 * element per document; `style-src 'self'` blocks that element, which left the editor without its
 * frame, size and theme. When the browser refused the element (it has no sheet), its text is
 * mirrored into a constructed style sheet, which the policy allows, and kept in sync as CodeMirror
 * adds rules. Only the element this first mount added is mirrored, so no other blocked inline
 * style gets through. Where styles apply anyway (no policy, tests), nothing changes.
 *
 * The browser still logs one CSP notice ("Applying inline style violates ...") for the refused
 * element; that is expected and harmless. Only a per-response nonce from the server, passed to
 * `EditorView.cspNonce`, would avoid it.
 */
export function withEditorStyles<T>(doc: Document, mount: () => T): T {
  if (handled.has(doc)) {
    return mount();
  }
  const before = new Set(doc.head.querySelectorAll("style"));
  const result = mount();
  const added = [...doc.head.querySelectorAll("style")].find((style) => !before.has(style));
  if (added !== undefined) {
    handled.add(doc);
    mirrorIfBlocked(doc, added);
  }
  return result;
}

/**
 * Whether the browser refused the element: no sheet at all, or (in some browsers) an empty sheet
 * although the element has text.
 */
function refused(style: HTMLStyleElement): boolean {
  const sheet = style.sheet;
  if (sheet === null) {
    return true;
  }
  let rules = 0;
  try {
    rules = sheet.cssRules.length;
  } catch {
    return true;
  }
  return rules === 0 && (style.textContent ?? "").trim() !== "";
}

function mirrorIfBlocked(doc: Document, style: HTMLStyleElement): void {
  const view = doc.defaultView;
  if (
    !refused(style) ||
    view === null ||
    typeof view.CSSStyleSheet !== "function" ||
    !Array.isArray(doc.adoptedStyleSheets)
  ) {
    return;
  }
  const sheet = new view.CSSStyleSheet();
  const sync = () => sheet.replaceSync(style.textContent ?? "");
  sync();
  // Unlayered like the element would be, so it ranks against the layered app styles as before.
  doc.adoptedStyleSheets = [sheet, ...doc.adoptedStyleSheets];
  new view.MutationObserver(sync).observe(style, {
    childList: true,
    characterData: true,
    subtree: true,
  });
}
