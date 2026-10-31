import { useId, useState } from "react";
import { TextField } from "../../components/TextField";
import { useI18n } from "../../i18n/i18n";
import { isAllowedUrl } from "./links";
import type { PanelLink, PanelModel, PanelRepeat, RowModel, VariableModel } from "./model";
import { isTimeFrom, isTimeShift } from "./panelTime";
import "./dashboards.css";
import "./dashboardTools.css";
import "./ui/shared.css";

/** The groups of the panel's own options, for showing some of them in one place. */
export type PanelExtrasPart = "library" | "row" | "repeat" | "time" | "links";
const ALL_PARTS: readonly PanelExtrasPart[] = ["library", "row", "repeat", "time", "links"];

interface PanelExtrasProps {
  panel: PanelModel;
  /** Which groups to show; all by default (the panel editor). */
  parts?: readonly PanelExtrasPart[];
  /** Without the frame and legend, inside a section that names them (the inspector). */
  bare?: boolean;
  onChange: (change: (panel: PanelModel) => PanelModel) => void;
  rows: readonly RowModel[];
  variables: readonly VariableModel[];
  /** The library panel this one shows, by name; absent for a panel of its own. */
  libraryName?: string | undefined;
  /** Turns the panel into a library panel (asks for a name and folder). */
  onMakeLibrary?: (() => void) | undefined;
}

/** What is wrong with the panel's own settings, or null: the editor keeps Apply until fixed. */
export function panelExtrasProblem(panel: PanelModel): string | null {
  if (panel.timeFrom !== undefined && !isTimeFrom(panel.timeFrom)) return "timeFrom";
  if (panel.timeShift !== undefined && !isTimeShift(panel.timeShift)) return "timeShift";
  if ((panel.links ?? []).some((l) => l.title.trim() === "" || !isAllowedUrl(l.url)))
    return "links";
  return null;
}

function without<K extends keyof PanelModel>(
  panel: PanelModel,
  key: K,
  value: PanelModel[K] | undefined,
) {
  const next = { ...panel };
  if (value === undefined || value === "" || (Array.isArray(value) && value.length === 0)) {
    delete next[key];
  } else {
    next[key] = value;
  }
  return next;
}

/**
 * The panel's place and own options in the panel editor: its row, a repeat, a time range or shift
 * of its own, data links and its library panel.
 */
export function PanelExtras({
  panel,
  parts = ALL_PARTS,
  bare = false,
  onChange,
  rows,
  variables,
  libraryName,
  onMakeLibrary,
}: PanelExtrasProps) {
  const { t } = useI18n();
  const id = useId();
  const [linkKeys, setLinkKeys] = useState(() =>
    (panel.links ?? []).map(() => crypto.randomUUID()),
  );
  const multi = variables.filter((v) => v.multi === true);
  const links = panel.links ?? [];
  const inRepeatedRow = rows.some((r) => r.id === panel.rowId && r.repeat !== undefined);
  const setLinks = (next: PanelLink[]) => onChange((p) => without(p, "links", next));
  const shows = (part: PanelExtrasPart) => parts.includes(part);

  const content = (
    <>
      {!shows("library") ? null : libraryName === undefined ? (
        onMakeLibrary === undefined ? null : (
          <button type="button" className="button button--secondary" onClick={onMakeLibrary}>
            {t("libraryPanels.make")}
          </button>
        )
      ) : (
        <div className="panel-extras__library">
          <p className="field__hint">{t("libraryPanels.linkedHint", { name: libraryName })}</p>
          <button
            type="button"
            className="button button--secondary"
            onClick={() => onChange((p) => without(p, "libraryPanelId", undefined))}
          >
            {t("libraryPanels.unlink")}
          </button>
        </div>
      )}
      {rows.length === 0 || !shows("row") ? null : (
        <div className="field">
          <label className="field__label" htmlFor={`${id}-row`}>
            {t("dashboardTools.panel.row")}
          </label>
          <select
            id={`${id}-row`}
            className="select"
            value={panel.rowId ?? ""}
            onChange={(event) => {
              const rowId = event.currentTarget.value;
              onChange((p) => without(p, "rowId", rowId === "" ? undefined : rowId));
            }}
          >
            <option value="">{t("dashboardTools.panel.noRow")}</option>
            {rows.map((row) => (
              <option key={row.id} value={row.id}>
                {row.title === "" ? t("dashboardTools.rows.untitled") : row.title}
              </option>
            ))}
          </select>
        </div>
      )}
      {!shows("repeat") ? null : (
        <div className="field">
          <label className="field__label" htmlFor={`${id}-repeat`}>
            {t("dashboardTools.repeat.variable")}
          </label>
          <p className="field__hint" id={`${id}-repeat-hint`}>
            {inRepeatedRow ? t("dashboardTools.repeat.inRow") : t("dashboardTools.repeat.hint")}
          </p>
          <select
            id={`${id}-repeat`}
            className="select"
            aria-describedby={`${id}-repeat-hint`}
            value={panel.repeat?.variable ?? ""}
            disabled={inRepeatedRow}
            onChange={(event) => {
              const variable = event.currentTarget.value;
              onChange((p) =>
                without(
                  p,
                  "repeat",
                  variable === "" ? undefined : { direction: "horizontal", ...p.repeat, variable },
                ),
              );
            }}
          >
            <option value="">{t("dashboardTools.repeat.none")}</option>
            {multi.map((v) => (
              <option key={v.name} value={v.name}>
                {v.label ?? v.name}
              </option>
            ))}
          </select>
        </div>
      )}
      {panel.repeat === undefined || !shows("repeat") ? null : (
        <div className="panel-extras__pair">
          <div className="field">
            <label className="field__label" htmlFor={`${id}-direction`}>
              {t("dashboardTools.repeat.direction")}
            </label>
            <select
              id={`${id}-direction`}
              className="select"
              value={panel.repeat.direction}
              onChange={(event) => {
                const direction = event.currentTarget.value as PanelRepeat["direction"];
                onChange((p) =>
                  p.repeat === undefined ? p : { ...p, repeat: { ...p.repeat, direction } },
                );
              }}
            >
              <option value="horizontal">{t("dashboardTools.repeat.horizontal")}</option>
              <option value="vertical">{t("dashboardTools.repeat.vertical")}</option>
            </select>
          </div>
          {panel.repeat.direction === "horizontal" ? (
            <div className="field">
              <label className="field__label" htmlFor={`${id}-per-row`}>
                {t("dashboardTools.repeat.perRow")}
              </label>
              <select
                id={`${id}-per-row`}
                className="select"
                value={panel.repeat.maxPerRow ?? 0}
                onChange={(event) => {
                  const n = Number(event.currentTarget.value);
                  onChange((p) => {
                    if (p.repeat === undefined) return p;
                    const { maxPerRow: _old, ...rest } = p.repeat;
                    return { ...p, repeat: n === 0 ? rest : { ...rest, maxPerRow: n } };
                  });
                }}
              >
                <option value={0}>{t("dashboardTools.repeat.perRowAll")}</option>
                {[1, 2, 3, 4, 6, 8, 12].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
        </div>
      )}
      {!shows("time") ? null : (
        <div className="panel-extras__pair">
          <TextField
            label={t("dashboardTools.time.from")}
            hint={t("dashboardTools.time.fromHint")}
            value={panel.timeFrom ?? ""}
            onValueChange={(text) => onChange((p) => without(p, "timeFrom", text.trim()))}
            error={
              panel.timeFrom !== undefined && !isTimeFrom(panel.timeFrom)
                ? t("dashboardTools.time.fromInvalid")
                : undefined
            }
            mono
            autoComplete="off"
          />
          <TextField
            label={t("dashboardTools.time.shift")}
            hint={t("dashboardTools.time.shiftHint")}
            value={panel.timeShift ?? ""}
            onValueChange={(text) => onChange((p) => without(p, "timeShift", text.trim()))}
            error={
              panel.timeShift !== undefined && !isTimeShift(panel.timeShift)
                ? t("dashboardTools.time.shiftInvalid")
                : undefined
            }
            mono
            autoComplete="off"
          />
        </div>
      )}
      {!shows("links") ? null : (
        <div className="panel-extras__links">
          <p className="field__label">{t("dashboardTools.dataLinks.title")}</p>
          <p className="field__hint">{t("dashboardTools.dataLinks.hint")}</p>
          {links.map((link, index) => (
            <div key={linkKeys[index]} className="settings__item">
              <TextField
                label={t("dashboardTools.links.linkTitle")}
                value={link.title}
                onValueChange={(title) =>
                  setLinks(links.map((l, i) => (i === index ? { ...l, title } : l)))
                }
                error={
                  link.title.trim() === "" ? t("dashboardTools.links.titleRequired") : undefined
                }
                autoComplete="off"
              />
              <TextField
                label={t("dashboardTools.links.url")}
                value={link.url}
                onValueChange={(url) =>
                  setLinks(links.map((l, i) => (i === index ? { ...l, url } : l)))
                }
                error={isAllowedUrl(link.url) ? undefined : t("dashboardTools.links.urlInvalid")}
                mono
                autoComplete="off"
              />
              <button
                type="button"
                className="button button--ghost"
                onClick={() => {
                  setLinks(links.filter((_, i) => i !== index));
                  setLinkKeys((keys) => keys.filter((_, i) => i !== index));
                }}
              >
                {t("dashboardTools.links.remove", {
                  title: link.title === "" ? t("dashboardTools.links.untitled") : link.title,
                })}
              </button>
            </div>
          ))}
          <button
            type="button"
            className="button button--secondary"
            onClick={() => {
              setLinks([...links, { title: "", url: "https://" }]);
              setLinkKeys((keys) => [...keys, crypto.randomUUID()]);
            }}
          >
            {t("dashboardTools.dataLinks.add")}
          </button>
        </div>
      )}
    </>
  );
  if (bare) {
    return <div className="panel-extras panel-extras--bare">{content}</div>;
  }
  return (
    <fieldset className="panel-editor__options panel-extras">
      {/* The panel editor's option group around it already shows a heading for these. */}
      <legend className="visually-hidden">{t("dashboards.editor.group.extras")}</legend>
      {content}
    </fieldset>
  );
}
