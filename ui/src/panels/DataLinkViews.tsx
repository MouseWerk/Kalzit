import { useState } from "react";
import { TextField } from "../components/TextField";
import type { VariableValues } from "../features/dashboards/model";
import { useI18n } from "../i18n/i18n";
import {
  type DataLink,
  isDataLinkUrl,
  MAX_DATA_LINK_TITLE,
  MAX_DATA_LINK_URL,
  MAX_DATA_LINKS,
  type OpenLink,
  VALUE_PLACEHOLDER,
} from "./dataLinks";
import { usePanelHost } from "./host";
import "./dataLinks.css";

const NO_VALUES: VariableValues = {};

/** The dashboard's variable values a data link may name; none outside a dashboard. */
export function useLinkValues(): VariableValues {
  return usePanelHost().linkValues ?? NO_VALUES;
}

/**
 * The data links of a field, node or edge as links. External addresses and those opening in a
 * new tab never hand the page or its address to the target (`noopener noreferrer`).
 */
export function DataLinkList({ links, label }: { links: readonly OpenLink[]; label: string }) {
  if (links.length === 0) {
    return null;
  }
  return (
    <ul className="data-links" aria-label={label}>
      {links.map((link, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: links keep their order; titles can repeat
        <li key={index}>
          <a
            className="button button--ghost button--small"
            href={link.href}
            rel="noopener noreferrer"
            {...(link.newTab ? { target: "_blank" } : {})}
          >
            {link.title}
          </a>
        </li>
      ))}
    </ul>
  );
}

/**
 * The data links of a document or graph panel in its editor: per link the field or property, a
 * title, the address and whether it opens in a new tab. The server refuses an address that is
 * not allowed, so the field says so while typing.
 */
export function DataLinksEditor({
  links = [],
  onChange,
  fieldLabel,
  fieldHint,
  maxField,
}: {
  /** Absent in options a page passes unparsed. */
  links: readonly DataLink[] | undefined;
  onChange: (links: DataLink[]) => void;
  fieldLabel: string;
  fieldHint: string;
  maxField: number;
}) {
  const { t } = useI18n();
  // Stable keys, so removing a link keeps the inputs of the others (and their focus) in place.
  const [keys, setKeys] = useState<string[]>(() => links.map(() => crypto.randomUUID()));
  if (keys.length !== links.length) {
    setKeys(links.map((_, i) => keys[i] ?? crypto.randomUUID()));
  }
  const change = (index: number, patch: Partial<DataLink>) =>
    onChange(links.map((link, i) => (i === index ? { ...link, ...patch } : link)));
  return (
    <div className="data-links-editor">
      <p className="field__hint">{t("panels.dataLinks.hint", { value: VALUE_PLACEHOLDER })}</p>
      {links.map((link, index) => (
        <div key={keys[index] ?? index} className="settings__item">
          <TextField
            label={fieldLabel}
            hint={fieldHint}
            value={link.field}
            maxLength={maxField}
            onValueChange={(field) => change(index, { field })}
            error={link.field.trim() === "" ? t("panels.dataLinks.fieldRequired") : undefined}
            mono
            autoComplete="off"
          />
          <TextField
            label={t("panels.dataLinks.linkTitle")}
            value={link.title}
            maxLength={MAX_DATA_LINK_TITLE}
            onValueChange={(title) => change(index, { title })}
            error={link.title.trim() === "" ? t("panels.dataLinks.titleRequired") : undefined}
            autoComplete="off"
          />
          <TextField
            label={t("panels.dataLinks.url")}
            hint={t("panels.dataLinks.urlHint", { value: VALUE_PLACEHOLDER })}
            value={link.url}
            maxLength={MAX_DATA_LINK_URL}
            onValueChange={(url) => change(index, { url })}
            error={isDataLinkUrl(link.url) ? undefined : t("panels.dataLinks.urlInvalid")}
            mono
            autoComplete="off"
          />
          <label className="checkbox">
            <input
              type="checkbox"
              checked={link.newTab}
              onChange={(event) => change(index, { newTab: event.currentTarget.checked })}
            />
            {t("panels.dataLinks.newTab")}
          </label>
          <div>
            <button
              type="button"
              className="button button--ghost button--small"
              onClick={() => {
                onChange(links.filter((_, i) => i !== index));
                setKeys(keys.filter((_, i) => i !== index));
              }}
            >
              {t("panels.dataLinks.remove", {
                title: link.title.trim() === "" ? t("panels.dataLinks.untitled") : link.title,
              })}
            </button>
          </div>
        </div>
      ))}
      {links.length >= MAX_DATA_LINKS ? (
        <p className="field__hint">{t("panels.dataLinks.full", { count: MAX_DATA_LINKS })}</p>
      ) : (
        <div>
          <button
            type="button"
            className="button button--secondary button--small"
            onClick={() => {
              onChange([...links, { field: "", title: "", url: "https://", newTab: false }]);
              setKeys([...keys, crypto.randomUUID()]);
            }}
          >
            {t("panels.dataLinks.add")}
          </button>
        </div>
      )}
    </div>
  );
}
