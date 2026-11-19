import type { Page } from "@playwright/test";
import { findOverflow } from "./overflow";

/**
 * The look-and-layout checks of the UI sweep (`npm run e2e:sweep`, e2e/sweep). They read the page
 * as it is drawn (boxes, computed colors, names) and answer findings; they never fail a test by
 * themselves. The checklist behind them is docs/quality/ui-pass-2026-11.md.
 */

export const CHECKS = [
  "overflow",
  "clipped-text",
  "truncated",
  "overlap",
  "target-size",
  "row-height",
  "contrast",
  "name",
  "focus",
  "state-frame",
] as const;
export type Check = (typeof CHECKS)[number] | "console" | "open";

/** broken: content lost or unusable; off: clearly wrong to the eye or a rule; polish: finish. */
export type Severity = "broken" | "off" | "polish";

export interface Finding {
  check: Check;
  severity: Severity;
  /** The element, as `parent > tag.class`, stable across runs and languages. */
  element: string;
  /** What the element says (its text or name), shortened. */
  label: string;
  /** What is wrong, with the measured values. */
  detail: string;
  /** The same finding without its measured values, to join it across widths and themes. */
  kind: string;
  /** Where the element is in the screenshot, in CSS pixels. */
  rect?: { x: number; y: number; width: number; height: number };
  /** The reason from the allow-list, when the finding is a known exception. */
  allowed?: string;
  /** The element in the page (an index into the sweep's references), while the page is open. */
  ref?: number;
}

export interface Allowed {
  check: Check;
  /** The pages it holds for, by name; every page when absent. */
  page?: RegExp;
  /** A CSS selector: the finding's element, or one it lies in, matches it. */
  selector: string;
  reason: string;
}

type RawFinding = Omit<Finding, "rect"> & { ref: number };

interface AuditInput {
  allowed: { check: string; selector: string; reason: string }[];
  minTarget: number;
}

/**
 * Runs in the page. Everything it needs is inside, because Playwright sends it as text.
 * `phase` "layout" looks at the page as it stands; "focus" moves the keyboard focus through every
 * control, so it runs last, after the screenshot.
 */
function auditInPage(input: AuditInput & { phase: "layout" | "focus" }): RawFinding[] {
  const store = window as unknown as { __kalzitSweep?: Element[] };
  store.__kalzitSweep ??= [];
  const refs = store.__kalzitSweep;
  const findings: RawFinding[] = [];

  // --- describing elements -------------------------------------------------------------------
  const own = (element: Element) => {
    const classes = [...element.classList]
      // State classes change with the state, not with the element.
      .filter((name) => !/^(is|has)-/.test(name))
      .slice(0, 2)
      .map((name) => `.${name}`)
      .join("");
    const role = element.getAttribute("role");
    return `${element.tagName.toLowerCase()}${classes}${classes === "" && role !== null ? `[role=${role}]` : ""}`;
  };
  const pathOf = (element: Element) => {
    let parent = element.parentElement;
    while (parent !== null && parent.classList.length === 0 && parent !== document.body) {
      parent = parent.parentElement;
    }
    return parent === null || parent === document.body
      ? own(element)
      : `${own(parent)} > ${own(element)}`;
  };
  const textOf = (element: Element): string => {
    if (element.getAttribute("aria-hidden") === "true") {
      return "";
    }
    const label = element.getAttribute("aria-label");
    if (label !== null && label.trim() !== "") {
      return label;
    }
    if (element instanceof HTMLImageElement) {
      return element.alt;
    }
    if (element instanceof SVGElement && element.tagName.toLowerCase() === "svg") {
      return element.querySelector("title")?.textContent ?? "";
    }
    let text = "";
    for (const node of element.childNodes) {
      if (node instanceof Text) {
        text += node.data;
      } else if (node instanceof Element) {
        text += ` ${textOf(node)} `;
      }
    }
    return text;
  };
  const squash = (text: string) => text.replace(/\s+/g, " ").trim();
  const labelOf = (element: Element) => {
    const text =
      squash(textOf(element)) ||
      (element instanceof HTMLInputElement ? element.placeholder || element.name : "") ||
      element.getAttribute("title") ||
      "";
    return text.length > 60 ? `${text.slice(0, 57)}...` : text;
  };
  const allowedFor = (check: string, element: Element): string | undefined =>
    input.allowed.find((entry) => entry.check === check && element.closest(entry.selector) !== null)
      ?.reason;
  const report = (
    check: RawFinding["check"],
    severity: Severity,
    element: Element,
    kind: string,
    detail: string,
  ) => {
    const finding: RawFinding = {
      check,
      severity,
      element: pathOf(element),
      label: labelOf(element),
      kind,
      detail,
      ref: refs.push(element) - 1,
    };
    const reason = allowedFor(check, element);
    if (reason !== undefined) {
      finding.allowed = reason;
    }
    findings.push(finding);
  };

  // --- what is on screen ---------------------------------------------------------------------
  // With a modal dialog open, only the dialog counts: the page behind it is inert.
  const modals = [...document.querySelectorAll<HTMLElement>("dialog[open]")].filter((dialog) =>
    dialog.matches(":modal"),
  );
  const scope: Element = modals.at(-1) ?? document.body;
  const styleCache = new WeakMap<Element, CSSStyleDeclaration>();
  const css = (element: Element) => {
    let style = styleCache.get(element);
    if (style === undefined) {
      style = getComputedStyle(element);
      styleCache.set(element, style);
    }
    return style;
  };
  const clips = (value: string) => value !== "visible";
  /** How much of the element its clipping ancestors leave: the visible box, or null for none. */
  const visibleBox = (element: Element): DOMRect | null => {
    let box = element.getBoundingClientRect();
    for (let a = element.parentElement; a !== null; a = a.parentElement) {
      const style = css(a);
      if (!clips(style.overflowX) && !clips(style.overflowY)) {
        continue;
      }
      const frame = a.getBoundingClientRect();
      const left = clips(style.overflowX) ? Math.max(box.left, frame.left) : box.left;
      const right = clips(style.overflowX) ? Math.min(box.right, frame.right) : box.right;
      const top = clips(style.overflowY) ? Math.max(box.top, frame.top) : box.top;
      const bottom = clips(style.overflowY) ? Math.min(box.bottom, frame.bottom) : box.bottom;
      if (right - left <= 0 || bottom - top <= 0) {
        return null;
      }
      box = new DOMRect(left, top, right - left, bottom - top);
    }
    return box;
  };
  const visibleCache = new WeakMap<Element, boolean>();
  const isVisible = (element: Element): boolean => {
    const cached = visibleCache.get(element);
    if (cached !== undefined) {
      return cached;
    }
    const rect = element.getBoundingClientRect();
    let visible =
      rect.width > 1 &&
      rect.height > 1 &&
      scope.contains(element) &&
      element.closest("[inert], [aria-hidden='true']") === null &&
      element.checkVisibility({ opacityProperty: true, visibilityProperty: true });
    if (visible) {
      const box = visibleBox(element);
      // Parked outside the window (an off-canvas navigation) is not on screen either.
      visible = box !== null && box.right > 0 && box.left < document.documentElement.clientWidth;
    }
    visibleCache.set(element, visible);
    return visible;
  };
  /**
   * The layer an element is drawn in: a dialog, menu or popover, or something fixed or sticky.
   * Elements of different layers lie over each other on purpose.
   */
  const layerOf = (element: Element): Element | null => {
    for (let a: Element | null = element; a !== null && a !== document.body; a = a.parentElement) {
      if (
        a.matches("dialog, [popover], [role='dialog'], [role='menu'], [role='listbox']") ||
        /^(fixed|sticky)$/.test(css(a).position)
      ) {
        return a;
      }
    }
    return null;
  };

  // --- colors --------------------------------------------------------------------------------
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  type Rgba = [number, number, number, number];
  const colorCache = new Map<string, Rgba>();
  /** Any CSS color (oklch included) as sRGB with alpha, as the browser paints it. */
  const rgba = (color: string): Rgba => {
    const cached = colorCache.get(color);
    if (cached !== undefined) {
      return cached;
    }
    let value: Rgba = [0, 0, 0, 0];
    if (context !== null) {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = "rgba(0, 0, 0, 0)";
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      const [r = 0, g = 0, b = 0, a = 0] = context.getImageData(0, 0, 1, 1).data;
      value = [r, g, b, a / 255];
    }
    colorCache.set(color, value);
    return value;
  };
  const over = (top: Rgba, below: Rgba): Rgba => {
    const alpha = top[3] + below[3] * (1 - top[3]);
    if (alpha === 0) {
      return [0, 0, 0, 0];
    }
    const mix = (i: 0 | 1 | 2) => (top[i] * top[3] + below[i] * below[3] * (1 - top[3])) / alpha;
    return [mix(0), mix(1), mix(2), alpha];
  };
  const linear = (channel: number) => {
    const c = channel / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const luminance = (c: Rgba) =>
    0.2126 * linear(c[0]) + 0.7152 * linear(c[1]) + 0.0722 * linear(c[2]);
  const ratio = (a: Rgba, b: Rgba) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
    return (hi + 0.05) / (lo + 0.05);
  };
  /** The chroma of a color in OKLCH: 0 for grey; the accent and the status colors are above 0.06. */
  const chroma = (c: Rgba) => {
    const [r, g, b] = [linear(c[0]), linear(c[1]), linear(c[2])];
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
    const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
    return Math.hypot(A, B);
  };
  /** Greys carry a hint of hue in the tokens (chroma up to about 0.012); a color is well above. */
  const COLORED = 0.04;
  const hex = (c: Rgba) =>
    `#${[c[0], c[1], c[2]].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
  const canvasColor = rgba(css(document.documentElement).backgroundColor);
  const pageColor: Rgba =
    canvasColor[3] > 0
      ? canvasColor
      : matchMedia("(prefers-color-scheme: dark)").matches
        ? [18, 18, 18, 1]
        : [255, 255, 255, 1];
  const colorsIn = (value: string) =>
    value.match(/(?:rgba?|oklch|oklab|color|hsla?|lab|lch)\([^)]*\)|#[0-9a-f]{3,8}\b/gi) ?? [];

  const INTERACTIVE = [
    "a[href]",
    "button",
    "input:not([type='hidden'])",
    "select",
    "textarea",
    "summary",
    "[role='button']",
    "[role='link']",
    "[role='tab']",
    "[role='menuitem']",
    "[role='menuitemradio']",
    "[role='menuitemcheckbox']",
    "[role='option']",
    "[role='switch']",
    "[role='checkbox']",
    "[role='radio']",
    "[role='combobox']",
    "[contenteditable='true']",
    "[tabindex]:not([tabindex='-1'])",
  ].join(", ");
  const isChoice = (element: Element): element is HTMLInputElement =>
    element instanceof HTMLInputElement && /^(checkbox|radio)$/.test(element.type);
  const isDisabled = (element: Element) =>
    element.closest(":disabled, [aria-disabled='true']") !== null;
  /**
   * The box that answers a click. A checkbox or radio answers on its label too, and the native
   * input is often drawn invisibly over a tile of its own.
   */
  const targetBox = (element: Element): DOMRect | null => {
    // What a scrolling frame hides answers no click: the box is the part left in view.
    if (!isChoice(element)) {
      if (!isVisible(element)) {
        return null;
      }
      // A field drawn inside its label (a search field with its icon) answers on the label.
      const frame = element.matches("input, select, textarea") ? element.closest("label") : null;
      const own = visibleBox(element);
      const outer = frame === null ? null : visibleBox(frame);
      if (own === null || outer === null) {
        return own;
      }
      const left = Math.min(own.left, outer.left);
      const top = Math.min(own.top, outer.top);
      return new DOMRect(
        left,
        top,
        Math.max(own.right, outer.right) - left,
        Math.max(own.bottom, outer.bottom) - top,
      );
    }
    const parts = [element, ...(element.labels ?? [])].filter(
      (part) =>
        scope.contains(part) &&
        part.getBoundingClientRect().width > 1 &&
        part.checkVisibility({ visibilityProperty: true }) &&
        visibleBox(part) !== null,
    );
    if (parts.length === 0) {
      return null;
    }
    const boxes = parts.map((part) => visibleBox(part) ?? part.getBoundingClientRect());
    const left = Math.min(...boxes.map((b) => b.left));
    const top = Math.min(...boxes.map((b) => b.top));
    return new DOMRect(
      left,
      top,
      Math.max(...boxes.map((b) => b.right)) - left,
      Math.max(...boxes.map((b) => b.bottom)) - top,
    );
  };
  const targets = [...scope.querySelectorAll(INTERACTIVE)]
    .map((element) => ({ element, box: targetBox(element), layer: layerOf(element) }))
    .filter((t): t is { element: Element; box: DOMRect; layer: Element | null } => t.box !== null);
  const px = (value: number) => `${Math.round(value * 10) / 10}`;

  if (input.phase === "focus") {
    focusCheck();
    return findings;
  }

  // --- clipped, spilling and truncated text ---------------------------------------------------
  const textHolders = new Set<Element>();
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (parent !== null && (node as Text).data.trim() !== "" && isVisible(parent)) {
      textHolders.add(parent);
    }
  }
  const LABELS = "button, a, h1, h2, h3, h4, label, th, legend, [role='tab'], [role='menuitem']";
  for (const element of textHolders) {
    if (element.closest(".cm-editor, svg, option") !== null) {
      continue;
    }
    const style = css(element);
    if (style.display === "inline" || style.display === "contents") {
      continue;
    }
    const sideways = element.scrollWidth - element.clientWidth;
    const down = element.scrollHeight - element.clientHeight;
    if (/^(hidden|clip)$/.test(style.overflowX) && sideways > 1) {
      if (style.textOverflow === "ellipsis") {
        // Cut with an ellipsis on purpose. On a label it still costs meaning, more so in German.
        const holder = element.closest(LABELS);
        if (holder !== null && element.closest("[title]") === null) {
          report(
            "truncated",
            "polish",
            element,
            "label cut with an ellipsis, no title",
            `${px(element.scrollWidth)} px of text in ${px(element.clientWidth)} px`,
          );
        }
      } else {
        report(
          "clipped-text",
          "broken",
          element,
          "text cut off at the side without an ellipsis",
          `${px(element.scrollWidth)} px of text in ${px(element.clientWidth)} px`,
        );
      }
    } else if (
      /^(hidden|clip)$/.test(style.overflowY) &&
      down > 3 &&
      style.webkitLineClamp === "none"
    ) {
      report(
        "clipped-text",
        "broken",
        element,
        "text cut off at the bottom",
        `${px(element.scrollHeight)} px of text in ${px(element.clientHeight)} px`,
      );
    } else if (style.overflowX === "visible") {
      const range = document.createRange();
      range.selectNodeContents(element);
      const text = range.getBoundingClientRect();
      const box = element.getBoundingClientRect();
      if (text.width > 0 && (text.right > box.right + 1.5 || text.left < box.left - 1.5)) {
        report(
          "clipped-text",
          "off",
          element,
          "text runs out of its box",
          `text ${px(text.width)} px wide in a box of ${px(box.width)} px`,
        );
      }
    }
    // Cut by a frame further up that does not scroll: part of the text is simply gone.
    const box = element.getBoundingClientRect();
    const left = visibleBox(element);
    if (left !== null && box.width - left.width > 2 && style.textOverflow !== "ellipsis") {
      let scrolls = false;
      for (let a = element.parentElement; a !== null; a = a.parentElement) {
        // A frame that scrolls, or one that ends its text in an ellipsis, cuts on purpose.
        if (/^(auto|scroll)$/.test(css(a).overflowX) || css(a).textOverflow === "ellipsis") {
          scrolls = true;
          break;
        }
      }
      if (!scrolls) {
        report(
          "clipped-text",
          "broken",
          element,
          "text cut off by a frame around it",
          `${px(box.width - left.width)} px of ${px(box.width)} px hidden`,
        );
      }
    }
  }

  // --- overlapping controls ------------------------------------------------------------------
  const FIELD = "input, textarea, select, [role='combobox'], [contenteditable='true']";
  const inside = (inner: DOMRect, outer: DOMRect) =>
    inner.left >= outer.left - 1 &&
    inner.right <= outer.right + 1 &&
    inner.top >= outer.top - 1 &&
    inner.bottom <= outer.bottom + 1;
  for (let i = 0; i < targets.length; i++) {
    for (let j = i + 1; j < targets.length; j++) {
      const a = targets[i];
      const b = targets[j];
      if (a === undefined || b === undefined || a.layer !== b.layer) {
        continue;
      }
      if (a.element.contains(b.element) || b.element.contains(a.element)) {
        continue;
      }
      // A checkbox and the label that belongs to it are one target.
      if (
        (isChoice(a.element) && [...(a.element.labels ?? [])].some((l) => l.contains(b.element))) ||
        (isChoice(b.element) && [...(b.element.labels ?? [])].some((l) => l.contains(a.element)))
      ) {
        continue;
      }
      let width = Math.min(a.box.right, b.box.right) - Math.max(a.box.left, b.box.left);
      let height = Math.min(a.box.bottom, b.box.bottom) - Math.max(a.box.top, b.box.top);
      if (width <= 2 || height <= 2) {
        continue;
      }
      // Links that wrap within a sentence: their boxes span lines, their line pieces decide.
      if (css(a.element).display === "inline" || css(b.element).display === "inline") {
        width = 0;
        height = 0;
        for (const p of a.element.getClientRects()) {
          for (const q of b.element.getClientRects()) {
            const w = Math.min(p.right, q.right) - Math.max(p.left, q.left);
            const h = Math.min(p.bottom, q.bottom) - Math.max(p.top, q.top);
            if (w > 2 && h > 2 && w * h > width * height) {
              width = w;
              height = h;
            }
          }
        }
        if (width === 0) {
          continue;
        }
      }
      // A button drawn inside a field (clear, show password) is part of the field.
      if (
        (a.element.matches(FIELD) && inside(b.box, a.box)) ||
        (b.element.matches(FIELD) && inside(a.box, b.box))
      ) {
        continue;
      }
      report(
        "overlap",
        "broken",
        b.element,
        `overlaps ${pathOf(a.element)}`,
        `"${labelOf(b.element)}" and "${labelOf(a.element)}" share ${px(width)} x ${px(height)} px`,
      );
    }
  }

  // --- target size (WCAG 2.2, 2.5.8) -----------------------------------------------------------
  const small = targets.filter(({ element, box }) => {
    if (isDisabled(element) || element.matches("[role='option'], option")) {
      return false;
    }
    // Half scrolled out of its frame: what is left in view says nothing about its size.
    const full = element.getBoundingClientRect();
    const seen = visibleBox(element);
    if (seen === null || full.width - seen.width > 1 || full.height - seen.height > 1) {
      return false;
    }
    // A link in a sentence is exempt: its size follows the line.
    if (
      element.matches("a") &&
      css(element).display === "inline" &&
      squash(element.parentElement?.textContent ?? "") !== squash(element.textContent ?? "")
    ) {
      return false;
    }
    return box.width < input.minTarget - 0.5 || box.height < input.minTarget - 0.5;
  });
  const centre = (box: DOMRect) => ({ x: box.left + box.width / 2, y: box.top + box.height / 2 });
  for (const target of small) {
    const c = centre(target.box);
    const radius = input.minTarget / 2;
    // The spacing exception: a 24 px circle around it touches no other target.
    const crowded = targets.some((other) => {
      if (
        other === target ||
        other.layer !== target.layer ||
        other.element.contains(target.element) ||
        target.element.contains(other.element)
      ) {
        return false;
      }
      const nearestX = Math.max(other.box.left, Math.min(c.x, other.box.right));
      const nearestY = Math.max(other.box.top, Math.min(c.y, other.box.bottom));
      if (Math.hypot(nearestX - c.x, nearestY - c.y) < radius) {
        return true;
      }
      if (small.includes(other)) {
        const o = centre(other.box);
        return Math.hypot(o.x - c.x, o.y - c.y) < 2 * radius;
      }
      return false;
    });
    // A text link or disclosure line with room around it meets the rule; it is not worth a line.
    if (!crowded && target.element.matches("a:not(.button), summary")) {
      continue;
    }
    report(
      "target-size",
      crowded ? "off" : "polish",
      target.element,
      crowded
        ? `target under ${input.minTarget} px with another target next to it`
        : `target under ${input.minTarget} px (spacing saves it)`,
      `${px(target.box.width)} x ${px(target.box.height)} px`,
    );
  }

  // --- controls of one row, one height -----------------------------------------------------------
  const boxed = (element: Element) => {
    const style = css(element);
    const border = Number.parseFloat(style.borderTopWidth) > 0 && rgba(style.borderTopColor)[3] > 0;
    return border || rgba(style.backgroundColor)[3] > 0;
  };
  const rows = new Map<Element, { element: Element; box: DOMRect }[]>();
  for (const { element, box } of targets) {
    if (
      !element.matches("button, a, input, select, [role='combobox'], [role='button']") ||
      isChoice(element) ||
      (element instanceof HTMLInputElement && /^(range|color|file)$/.test(element.type)) ||
      box.height < 18 ||
      box.height > 64 ||
      !boxed(element)
    ) {
      continue;
    }
    let container: Element | null = null;
    for (let a = element.parentElement, depth = 0; a !== null && depth < 3; a = a.parentElement) {
      depth += 1;
      const style = css(a);
      if (/flex|grid/.test(style.display)) {
        container = a;
        break;
      }
    }
    if (container !== null) {
      rows.set(container, [...(rows.get(container) ?? []), { element, box }]);
    }
  }
  for (const [container, controls] of rows) {
    const used = new Set<number>();
    controls.forEach((first, index) => {
      if (used.has(index)) {
        return;
      }
      const row = controls.filter((other, at) => {
        const same =
          !used.has(at) &&
          Math.abs(centre(other.box).y - centre(first.box).y) <
            Math.min(other.box.height, first.box.height) / 2;
        if (same) {
          used.add(at);
        }
        return same;
      });
      const heights = row.map((control) => control.box.height);
      const spread = Math.max(...heights) - Math.min(...heights);
      if (row.length > 1 && spread > 1) {
        const parts = row
          .map(
            (control) =>
              `"${labelOf(control.element) || own(control.element)}" ${px(control.box.height)}`,
          )
          .join(", ");
        report(
          "row-height",
          spread > 3 ? "off" : "polish",
          container,
          "controls of one row differ in height",
          `${parts} px`,
        );
      }
    });
  }

  // --- text contrast (WCAG 2.2, 1.4.3) ---------------------------------------------------------
  const mix = (from: Rgba, to: Rgba, share: number): Rgba => [
    from[0] + (to[0] - from[0]) * share,
    from[1] + (to[1] - from[1]) * share,
    from[2] + (to[2] - from[2]) * share,
    1,
  ];
  /**
   * The text and what lies behind it as they reach the screen. An element with opacity fades
   * everything in it, its own background and the text alike, toward what lies behind the
   * element, so both colors are carried down the chain together. Null when a picture or gradient
   * lies behind the text.
   */
  const painted = (element: Element, color: Rgba): { text: Rgba; background: Rgba } | null => {
    const chain: Element[] = [];
    for (let a: Element | null = element; a !== null; a = a.parentElement) {
      chain.unshift(a);
    }
    const draw = (index: number, behind: Rgba): { text: Rgba; background: Rgba } | null => {
      const node = chain[index];
      if (node === undefined) {
        return null;
      }
      const style = css(node);
      if (style.backgroundImage !== "none") {
        return null;
      }
      const own = over(rgba(style.backgroundColor), behind);
      const inner =
        index === chain.length - 1
          ? { text: over(color, own), background: own }
          : draw(index + 1, own);
      if (inner === null) {
        return null;
      }
      const opacity = Number.parseFloat(style.opacity);
      return opacity >= 1
        ? inner
        : {
            text: mix(behind, inner.text, opacity),
            background: mix(behind, inner.background, opacity),
          };
    };
    return draw(0, [pageColor[0], pageColor[1], pageColor[2], 1]);
  };
  const checkContrast = (element: Element, color: string, what: string) => {
    const raw = rgba(color);
    const drawn = raw[3] === 0 ? null : painted(element, raw);
    if (drawn === null) {
      return;
    }
    const { text, background } = drawn;
    const style = css(element);
    const size = Number.parseFloat(style.fontSize);
    const large = size >= 24 || (size >= 18.66 && Number.parseInt(style.fontWeight, 10) >= 700);
    const needed = large ? 3 : 4.5;
    const found = ratio(text, background);
    if (found < needed - 0.05) {
      report(
        "contrast",
        found < 3 ? "broken" : "off",
        element,
        `${what} below ${needed}:1`,
        `${found.toFixed(2)}:1, ${hex(text)} on ${hex(background)}, ${px(size)} px`,
      );
    }
  };
  for (const element of textHolders) {
    if (isDisabled(element) || element.closest("svg, option") !== null) {
      continue;
    }
    const style = css(element);
    const fill = style.getPropertyValue("-webkit-text-fill-color");
    checkContrast(element, fill !== "" && fill !== style.color ? fill : style.color, "text");
  }
  for (const field of scope.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
    "input[placeholder], textarea[placeholder]",
  )) {
    if (field.value === "" && field.placeholder !== "" && isVisible(field) && !isDisabled(field)) {
      checkContrast(field, getComputedStyle(field, "::placeholder").color, "placeholder");
    }
  }

  // --- accessible names --------------------------------------------------------------------------
  const byIds = (ids: string | null) =>
    squash(
      (ids ?? "")
        .split(/\s+/)
        .map((id) => (id === "" ? "" : (document.getElementById(id)?.textContent ?? "")))
        .join(" "),
    );
  for (const { element } of targets) {
    if (element.matches("[role='option'], option") && squash(element.textContent ?? "") !== "") {
      continue;
    }
    let name = byIds(element.getAttribute("aria-labelledby")) || squash(textOf(element));
    if (
      name === "" &&
      (element instanceof HTMLInputElement ||
        element instanceof HTMLSelectElement ||
        element instanceof HTMLTextAreaElement)
    ) {
      name = squash([...(element.labels ?? [])].map((label) => textOf(label)).join(" "));
      if (name === "" && element instanceof HTMLInputElement) {
        name = /^(button|submit|reset)$/.test(element.type) ? element.value : "";
      }
      if (name === "" && !(element instanceof HTMLSelectElement) && element.placeholder !== "") {
        report(
          "name",
          "polish",
          element,
          "field named by its placeholder only",
          `placeholder "${element.placeholder}"`,
        );
        continue;
      }
    }
    if (name === "") {
      name = element.getAttribute("title") ?? "";
    }
    if (name === "") {
      report("name", "off", element, "control without an accessible name", own(element));
    }
  }
  for (const image of scope.querySelectorAll("img:not([alt]), svg[role='img']")) {
    if (
      isVisible(image) &&
      squash(textOf(image)) === "" &&
      byIds(image.getAttribute("aria-labelledby")) === ""
    ) {
      report("name", "off", image, "image without a text alternative", own(image));
    }
  }

  // --- selected and current states: no colored frames ---------------------------------------------
  const STATES = [
    "[aria-current]:not([aria-current='false'])",
    "[aria-selected='true']",
    "[aria-pressed='true']",
    "[aria-checked='true']:not(input)",
    "[data-selected='true']",
    "[data-active='true']",
    ".is-active",
    ".is-selected",
    ".is-current",
  ].join(", ");
  for (const element of scope.querySelectorAll(STATES)) {
    if (!isVisible(element)) {
      continue;
    }
    const style = css(element);
    const fill = rgba(style.backgroundColor);
    const filled = fill[3] > 0.5 && chroma(fill) > COLORED;
    const sides = ["Top", "Right", "Bottom", "Left"] as const;
    const framed = sides.filter((side) => {
      const color = rgba(style[`border${side}Color`]);
      return (
        Number.parseFloat(style[`border${side}Width`]) > 0 &&
        color[3] > 0.3 &&
        chroma(color) > COLORED
      );
    });
    // A control filled with the accent (a primary choice) has its border in the same color.
    if (framed.length > 0 && !filled) {
      report(
        "state-frame",
        "off",
        element,
        "selected or current state drawn with a colored border",
        `border ${framed.join(", ").toLowerCase()} ${hex(rgba(style[`border${framed[0] ?? "Top"}Color`]))}`,
      );
    }
    const outline = rgba(style.outlineColor);
    if (
      style.outlineStyle !== "none" &&
      Number.parseFloat(style.outlineWidth) > 0 &&
      chroma(outline) > COLORED
    ) {
      report(
        "state-frame",
        "off",
        element,
        "selected or current state drawn with a colored outline",
        hex(outline),
      );
    }
    const glow = colorsIn(style.boxShadow)
      .map(rgba)
      .find((c) => c[3] > 0.2 && chroma(c) > COLORED);
    if (style.boxShadow !== "none" && glow !== undefined && !filled) {
      report(
        "state-frame",
        "off",
        element,
        "selected or current state drawn with a colored shadow or glow",
        hex(glow),
      );
    }
    for (const pseudo of ["::before", "::after"]) {
      const bar = getComputedStyle(element, pseudo);
      const color = rgba(bar.backgroundColor);
      const width = Number.parseFloat(bar.width);
      const height = Number.parseFloat(bar.height);
      if (
        bar.content !== "none" &&
        bar.position === "absolute" &&
        color[3] > 0.3 &&
        chroma(color) > COLORED &&
        ((width <= 4 && height > 8) || (height <= 4 && width > 8))
      ) {
        report(
          "state-frame",
          "off",
          element,
          "selected or current state drawn with a colored bar",
          `${pseudo} ${px(width)} x ${px(height)} px ${hex(color)}`,
        );
      }
    }
  }
  return findings;

  // --- the focus ring: there, neutral, the same everywhere ----------------------------------------
  function focusCheck(): void {
    /** Below this alpha a line is not seen. */
    const VISIBLE = 0.1;
    const snapshot = (element: Element) => {
      const style = getComputedStyle(element);
      return {
        outline: style.outlineStyle === "none" ? "" : `${style.outlineWidth} ${style.outlineColor}`,
        outlineColor: style.outlineColor,
        outlineWidth: style.outlineStyle === "none" ? 0 : Number.parseFloat(style.outlineWidth),
        shadow: style.boxShadow,
        border: `${style.borderTopColor} ${style.borderRightColor} ${style.borderBottomColor} ${style.borderLeftColor}`,
        fill: style.backgroundColor,
      };
    };
    for (const { element } of targets) {
      if (
        !(element instanceof HTMLElement) ||
        isDisabled(element) ||
        element.tabIndex < 0 ||
        element.matches("[role='option'], option")
      ) {
        continue;
      }
      // The ring may sit on the control, on a frame around it or on the tile of a hidden input.
      const around = [
        element,
        element.parentElement,
        element.parentElement?.parentElement,
        element.nextElementSibling,
        ...(isChoice(element) ? [...(element.labels ?? [])] : []),
      ].filter((e): e is Element => e !== null && e !== undefined);
      // Without the focus of the control before: a frame both share would hide the change.
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
      const before = around.map(snapshot);
      element.focus({ preventScroll: true });
      if (document.activeElement !== element || !element.matches(":focus-visible")) {
        continue;
      }
      for (const part of around) {
        for (const animation of part.getAnimations()) {
          animation.finish();
        }
      }
      const after = around.map(snapshot);
      const changed: Rgba[] = [];
      let ring = 0;
      let tintOnly = false;
      after.forEach((now, index) => {
        const was = before[index];
        if (was === undefined) {
          return;
        }
        // A change to a transparent outline, shadow or border draws nothing: no ring.
        const drawn = (colors: Rgba[]) => colors.filter((c) => c[3] > VISIBLE);
        const outline = drawn([rgba(now.outlineColor)]);
        if (now.outline !== was.outline && now.outlineWidth > 0 && outline.length > 0) {
          changed.push(...outline);
          ring = Math.max(ring, now.outlineWidth);
        }
        const shadow = drawn(colorsIn(now.shadow).map(rgba));
        if (now.shadow !== was.shadow && now.shadow !== "none" && shadow.length > 0) {
          changed.push(...shadow);
          ring = Math.max(ring, 2);
        }
        const border = drawn(colorsIn(now.border).map(rgba));
        if (now.border !== was.border && border.length > 0) {
          changed.push(...border);
          ring = Math.max(ring, 1);
        }
        if (now.fill !== was.fill && changed.length === 0) {
          tintOnly = true;
        }
      });
      const colored = changed.find((c) => c[3] > 0.2 && chroma(c) > COLORED);
      if (colored !== undefined) {
        report(
          "focus",
          "off",
          element,
          "focus ring is not neutral",
          `${hex(colored)}, chroma ${chroma(colored).toFixed(3)}`,
        );
      } else if (changed.length === 0) {
        report(
          "focus",
          "off",
          element,
          tintOnly ? "keyboard focus shown by a tint only, no ring" : "no visible keyboard focus",
          own(element),
        );
      } else if (ring < 2) {
        report("focus", "polish", element, "focus ring thinner than 2 px", `${px(ring)} px`);
      }
    }
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  }
}

/** Smallest pointer target of WCAG 2.2 AA (2.5.8), in CSS pixels. */
export const MIN_TARGET = 24;

function inputFor(allowed: readonly Allowed[], pageName: string): AuditInput {
  return {
    allowed: allowed
      .filter((entry) => entry.page === undefined || entry.page.test(pageName))
      .map(({ check, selector, reason }) => ({ check, selector, reason })),
    minTarget: MIN_TARGET,
  };
}

/**
 * Reads where the findings' elements are now: after the audit, and again once the window changed
 * size for the screenshot.
 */
export async function measure(page: Page, findings: Finding[]): Promise<Finding[]> {
  const rects = await page.evaluate(
    (refs) =>
      refs.map((ref) => {
        const element =
          ref === null
            ? undefined
            : (window as unknown as { __kalzitSweep?: Element[] }).__kalzitSweep?.[ref];
        if (element === undefined || !element.isConnected) {
          return null;
        }
        const box = element.getBoundingClientRect();
        return { x: box.x, y: box.y, width: box.width, height: box.height };
      }),
    findings.map((finding) => finding.ref ?? null),
  );
  return findings.map((finding, index) => {
    const rect = rects[index];
    return rect === null || rect === undefined ? finding : { ...finding, rect };
  });
}

/** How tall the window has to be to show the whole page without scrolling anything. */
export function contentHeight(page: Page): Promise<number> {
  return page.evaluate(() => {
    let extra = document.documentElement.scrollHeight - document.documentElement.clientHeight;
    for (const element of document.querySelectorAll("body *")) {
      const style = getComputedStyle(element);
      if (/^(auto|scroll)$/.test(style.overflowY) && element.clientHeight > 200) {
        extra = Math.max(extra, element.scrollHeight - element.clientHeight);
      }
    }
    return window.innerHeight + Math.max(0, extra);
  });
}

/**
 * The layout checks on the page as it stands: text that is cut or runs out of its box, controls
 * that overlap, small targets, uneven rows, contrast, names and colored frames on states, plus
 * what sticks out to the right (support/overflow.ts).
 */
export async function auditLayout(
  page: Page,
  pageName: string,
  allowed: readonly Allowed[],
): Promise<Finding[]> {
  const input = inputFor(allowed, pageName);
  const raw = await page.evaluate(auditInPage, { ...input, phase: "layout" as const });
  const findings = await measure(page, raw);
  const overflow = await findOverflow(page);
  const texts = [...overflow.offenders];
  if (overflow.scrollWidth > overflow.width && texts.length === 0) {
    texts.push(`html scrolls sideways: ${overflow.scrollWidth} px in ${overflow.width} px`);
  }
  // The overflow check names its elements as `tag.class`; an exception holds for the ones its
  // selector matches (the element or one it lies in), like every other check's.
  const reasons = await page.evaluate(
    ({ names, entries }) =>
      names.map((name) => {
        let elements: Element[] = [];
        try {
          elements = [...document.querySelectorAll(name)];
        } catch {
          // A class name CSS cannot spell: no exception applies.
        }
        return (
          entries.find(
            (entry) =>
              elements.length > 0 &&
              elements.every((element) => element.closest(entry.selector) !== null),
          )?.reason ?? null
        );
      }),
    {
      names: texts.map((text) => text.split(" ")[0] ?? ""),
      entries: input.allowed.filter((entry) => entry.check === "overflow"),
    },
  );
  texts.forEach((text, index) => {
    const reason = reasons[index];
    findings.push({
      check: "overflow",
      severity: "broken",
      element: text.split(" ")[0] ?? "",
      label: "",
      kind: `${text.split(" ")[0] ?? ""} sticks out to the right`,
      detail: text,
      ...(reason === null || reason === undefined ? {} : { allowed: reason }),
    });
  });
  return findings;
}

/**
 * The focus check: puts the keyboard focus on every control in turn and reads the ring. It moves
 * the focus, so it runs after everything else on a page.
 */
export async function auditFocus(
  page: Page,
  pageName: string,
  allowed: readonly Allowed[],
): Promise<Finding[]> {
  // A key press first: only then does a focus set by script count as keyboard focus.
  await page.keyboard.press("Tab");
  await page.evaluate(() => {
    (window as unknown as { __kalzitSweep?: Element[] }).__kalzitSweep = [];
  });
  const raw = await page.evaluate(auditInPage, {
    ...inputFor(allowed, pageName),
    phase: "focus" as const,
  });
  return measure(page, raw);
}
