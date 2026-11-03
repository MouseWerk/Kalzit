import { isRecord } from "../api/client";
import { fillVariables } from "../features/dashboards/links";
import type { VariableValues } from "../features/dashboards/model";
import { clipChars } from "../lib/chars";
import { isSafeHref } from "./fieldConfig/fieldConfig";
import { variableText } from "./variableClick";

/**
 * Data links of the document and graph panels: a link on a document field or a node or edge
 * property, offered where that field has a plain value. The server keeps the same limits and the
 * same address rule (`server/src/dashboards/panel_options.rs`, `check_data_links`).
 */
export interface DataLink {
  /** A dotted field path (document panels) or a property key (graph panels). */
  field: string;
  title: string;
  /**
   * The address: `https://`, `http://` or a page of this server (`/dashboards/...`), with
   * `${__value}`, `${__field}` and dashboard variables (`${region}`) filled in URL-encoded.
   */
  url: string;
  newTab: boolean;
}

/** A data link ready to open: its title and the filled-in, checked address. */
export interface OpenLink {
  title: string;
  href: string;
  newTab: boolean;
}

export const MAX_DATA_LINKS = 20;
export const MAX_DATA_LINK_TITLE = 200;
export const MAX_DATA_LINK_URL = 2048;

// biome-ignore lint/suspicious/noTemplateCurlyInString: a placeholder users type
export const VALUE_PLACEHOLDER = "${__value}";

/**
 * The address rule of a data link, before and after filling in: `http://` or `https://` with a
 * host, or a path on this server (not `//host`). No backslash, no control character, no spaces
 * at the ends; `javascript:`, `data:` and `mailto:` never pass.
 */
export function isDataLinkUrl(url: string): boolean {
  if (url === "" || url !== url.trim() || url.includes("\\") || /\p{Cc}/u.test(url)) {
    return false;
  }
  const lower = url.toLowerCase();
  for (const scheme of ["https://", "http://"]) {
    if (lower.startsWith(scheme)) {
      const rest = url.slice(scheme.length);
      return rest !== "" && !rest.startsWith("/");
    }
  }
  return url.startsWith("/") && !url.startsWith("//");
}

/** A stored text without control characters, cut to `max` characters; the ends stay as typed. */
function storedText(value: unknown, max: number): string {
  return typeof value === "string" ? clipChars(value.replace(/\p{Cc}/gu, ""), max) : "";
}

/**
 * The data links as stored, at most `MAX_DATA_LINKS`. Links still being typed (an empty title,
 * an address that is not allowed yet) are kept for the editor; panels offer only complete ones.
 */
export function parseDataLinks(value: unknown, maxField: number): DataLink[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter(isRecord)
    .slice(0, MAX_DATA_LINKS)
    .map((link) => ({
      field: storedText(link.field, maxField),
      title: storedText(link.title, MAX_DATA_LINK_TITLE),
      url: storedText(link.url, MAX_DATA_LINK_URL),
      newTab: link.newTab === true,
    }));
}

/** Whether a link is complete: a field, a title and an allowed address. */
export function isCompleteLink(link: DataLink): boolean {
  return link.field.trim() !== "" && link.title.trim() !== "" && isDataLinkUrl(link.url);
}

/**
 * The address of a link for one value: `${__value}` and `${__field}` and the dashboard's
 * variables filled in URL-encoded, then checked again, so a value can never turn the link into
 * script or another site's address. Null when the value is not a plain one or the result is not
 * allowed.
 */
export function dataLinkHref(
  link: DataLink,
  value: unknown,
  values: VariableValues = {},
): string | null {
  const text = variableText(value);
  if (text === null || text === "" || !isCompleteLink(link)) {
    return null;
  }
  const filled = fillVariables(link.url, values, { __value: text, __field: link.field.trim() });
  return isDataLinkUrl(filled) && isSafeHref(filled) ? filled : null;
}

/** The links of `field` for a value, ready to open; links that do not fit it are left out. */
export function linksForField(
  links: readonly DataLink[] | undefined,
  field: string,
  value: unknown,
  values: VariableValues = {},
): OpenLink[] {
  return (links ?? []).flatMap((link) => {
    if (link.field.trim() !== field) {
      return [];
    }
    const href = dataLinkHref(link, value, values);
    return href === null ? [] : [{ title: link.title, href, newTab: link.newTab }];
  });
}

/**
 * The value a graph link reads from a node or an edge: the property with that key, else for
 * `id` the element's own id, so a link can name a node without an id property.
 */
export function graphValue(
  properties: Readonly<Record<string, unknown>>,
  id: string,
  field: string,
): unknown {
  if (Object.hasOwn(properties, field)) {
    return properties[field];
  }
  return field === "id" ? id : undefined;
}

/**
 * The links of a whole record, a node's or edge's properties or a document: each link takes the
 * value its field has in it (`read` finds it, a dotted path for documents).
 */
export function linksForRecord(
  links: readonly DataLink[] | undefined,
  read: (field: string) => unknown,
  values: VariableValues = {},
): OpenLink[] {
  // Options a page passes unparsed have no list.
  return (links ?? []).flatMap((link) => {
    const field = link.field.trim();
    if (field === "") {
      return [];
    }
    const href = dataLinkHref(link, read(field), values);
    return href === null ? [] : [{ title: link.title, href, newTab: link.newTab }];
  });
}
