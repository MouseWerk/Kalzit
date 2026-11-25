import { type KeyboardEvent, useId, useState } from "react";
import { FormAlert } from "../../components/FormAlert";
import { TextField } from "../../components/TextField";
import { type MessageKey, type Translate, useI18n } from "../../i18n/i18n";
import { tabForKey } from "../../lib/tabKeys";
import type { Dashboard } from "./api";
import { type Change, diffModels, type JsonSection, jsonSections, type PanelPart } from "./diff";
import type { DashboardModel } from "./model";
import { Dialog } from "./ui/Dialog";
import "./dashboards.css";

/** The server's limit on a version message (docs/api/settings-dashboards.md). */
const MESSAGE_MAX = 500;

/** What a save also keeps as the dashboard's defaults, besides the changes. */
export interface SaveKeep {
  range: boolean;
  values: boolean;
}

type SaveTab = "changes" | "json";
const SAVE_TABS: readonly SaveTab[] = ["changes", "json"];

/**
 * Saves the dashboard (ParityEditors board, frame 13): the changes in words, or line by line as
 * JSON, a version message, and, when the range or the variable values on screen differ from the
 * saved defaults, the offer to keep them as the new defaults (unticked, the stored ones stay).
 * "Save as copy" keeps the saved dashboard as it is and makes a new one of the changes.
 */
export function SaveDialog({
  busy,
  error,
  base,
  draft,
  version,
  changed = true,
  rangeChanged = false,
  valuesChanged = false,
  onSave,
  onSaveCopy,
  onClose,
}: {
  busy: boolean;
  error: string | undefined;
  /** The saved dashboard this edit started from, and the edited one. */
  base: DashboardModel;
  draft: DashboardModel;
  /** The saved version; the save makes the next one. */
  version: number;
  /**
   * The dashboard itself changed. Without that, saving only makes sense with a default ticked,
   * so a save never writes a version that changes nothing.
   */
  changed?: boolean;
  /** The range on screen differs from the dashboard's default. */
  rangeChanged?: boolean;
  /** Variable values on screen differ from those the dashboard opens with. */
  valuesChanged?: boolean;
  onSave: (message: string, keep: SaveKeep) => void;
  /** Saves the changes as a new dashboard instead; absent without the right to create one. */
  onSaveCopy?: (() => void) | undefined;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [message, setMessage] = useState("");
  const [keepRange, setKeepRange] = useState(false);
  const [keepValues, setKeepValues] = useState(false);
  const [tab, setTab] = useState<SaveTab>("changes");
  const formId = useId();
  const tabsId = useId();
  const changes = diffModels(base, draft);
  const nothing = !changed && !(rangeChanged && keepRange) && !(valuesChanged && keepValues);
  const labels: Record<SaveTab, string> = {
    changes: t("dashboards.save.changes"),
    json: t("dashboards.save.jsonTab"),
  };
  function onTabKey(event: KeyboardEvent<HTMLDivElement>) {
    const next = tabForKey(SAVE_TABS, tab, event.key);
    if (next === undefined) return;
    event.preventDefault();
    setTab(next);
    document.getElementById(`${tabsId}-${next}-tab`)?.focus();
  }
  return (
    <Dialog
      title={t("dashboards.save.title")}
      onClose={onClose}
      size="large"
      actions={
        <>
          <button type="button" className="button button--secondary" onClick={onClose}>
            {t("dashboards.dialog.cancel")}
          </button>
          {onSaveCopy === undefined ? null : (
            <button type="button" className="button button--secondary" onClick={onSaveCopy}>
              {t("dashboards.save.copy")}
            </button>
          )}
          <button
            type="submit"
            form={formId}
            className="button button--primary"
            disabled={busy || nothing}
            aria-disabled={busy || nothing}
          >
            {busy ? t("dashboards.save.saving") : t("dashboards.save.submit")}
          </button>
        </>
      }
    >
      <p className="field__hint">
        {t("dashboards.save.version", { title: draft.title, from: version, to: version + 1 })}
      </p>
      {changes.length === 0 ? null : (
        <div className="save-changes">
          <div
            className="tabs save-changes__tabs"
            role="tablist"
            aria-label={t("dashboards.save.changesLabel")}
            onKeyDown={onTabKey}
          >
            {SAVE_TABS.map((name) => (
              <button
                key={name}
                type="button"
                role="tab"
                id={`${tabsId}-${name}-tab`}
                className="tabs__tab"
                aria-selected={tab === name}
                aria-controls={`${tabsId}-${name}`}
                tabIndex={tab === name ? 0 : -1}
                onClick={() => setTab(name)}
              >
                {labels[name]}
                {name === "changes" ? <span className="tabs__count">{changes.length}</span> : null}
              </button>
            ))}
          </div>
          <div
            role="tabpanel"
            id={`${tabsId}-changes`}
            aria-labelledby={`${tabsId}-changes-tab`}
            hidden={tab !== "changes"}
            className="save-changes__panel"
            // biome-ignore lint/a11y/noNoninteractiveTabindex: a scroll container needs focus to scroll by keyboard
            tabIndex={0}
          >
            <ChangeRows changes={changes} />
          </div>
          <div
            role="tabpanel"
            id={`${tabsId}-json`}
            aria-labelledby={`${tabsId}-json-tab`}
            hidden={tab !== "json"}
            className="save-changes__panel"
            // biome-ignore lint/a11y/noNoninteractiveTabindex: a scroll container needs focus to scroll by keyboard
            tabIndex={0}
          >
            {tab === "json" ? <JsonDiff sections={jsonSections(base, draft)} /> : null}
          </div>
        </div>
      )}
      <form
        id={formId}
        className="form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (nothing) return;
          onSave(message.trim(), {
            range: rangeChanged && keepRange,
            values: valuesChanged && keepValues,
          });
        }}
      >
        <FormAlert>{error}</FormAlert>
        <TextField
          label={t("dashboards.save.message")}
          hint={t("dashboards.save.messageHint")}
          value={message}
          onValueChange={setMessage}
          maxLength={MESSAGE_MAX}
          autoComplete="off"
          data-autofocus
        />
        {rangeChanged ? (
          <label className="checkbox">
            <input
              type="checkbox"
              checked={keepRange}
              onChange={(event) => setKeepRange(event.currentTarget.checked)}
            />
            {t("dashboards.save.keepRange")}
          </label>
        ) : null}
        {valuesChanged ? (
          <label className="checkbox">
            <input
              type="checkbox"
              checked={keepValues}
              onChange={(event) => setKeepValues(event.currentTarget.checked)}
            />
            {t("dashboards.save.keepValues")}
          </label>
        ) : null}
        {rangeChanged || valuesChanged ? (
          <p className="field__hint">
            {changed ? t("dashboards.save.keepHint") : t("dashboards.save.keepNeeded")}
          </p>
        ) : null}
      </form>
    </Dialog>
  );
}

const PART_KEYS: Record<PanelPart, MessageKey> = {
  title: "dashboards.diff.part.title",
  type: "dashboards.diff.part.type",
  queries: "dashboards.diff.part.queries",
  queryOptions: "dashboards.diff.part.queryOptions",
  steps: "dashboards.diff.part.steps",
  options: "dashboards.diff.part.options",
  fields: "dashboards.diff.part.fields",
  links: "dashboards.diff.part.links",
  other: "dashboards.diff.part.other",
};

/** What a change is, said in one word next to it: added, changed or removed. */
function changeStatus(change: Change): "added" | "changed" | "removed" {
  return change.kind === "panelAdded"
    ? "added"
    : change.kind === "panelRemoved"
      ? "removed"
      : "changed";
}

export function changeText(t: Translate, change: Change): string {
  switch (change.kind) {
    case "title":
      return t("dashboards.diff.title", { from: change.from, to: change.to });
    case "timeRange":
      return t("dashboards.diff.timeRange");
    case "refresh":
      return t("dashboards.diff.refresh");
    case "timeOptions":
      return t("toolbar.diff.timeOptions");
    case "variables":
      return change.names === undefined
        ? t("dashboards.diff.variables")
        : t("dashboards.diff.variablesList", {
            names: change.names.map((name) => `$${name}`).join(", "),
          });
    case "settings":
      return t(`dashboards.diff.settings.${change.part}`);
    case "panelAdded":
      return t("dashboards.diff.panelAdded", { title: change.title });
    case "panelRemoved":
      return t("dashboards.diff.panelRemoved", { title: change.title });
    case "panelChanged":
      return change.parts === undefined
        ? t("dashboards.diff.panelChanged", { title: change.title })
        : t("dashboards.diff.panelChangedParts", {
            title: change.title,
            parts: change.parts.map((part) => t(PART_KEYS[part])).join(", "),
          });
    case "panelMoved":
      return t("dashboards.diff.panelMoved", { title: change.title });
  }
}

/** The changes in words, each with its status as a word (not only as a colour). */
function ChangeRows({ changes }: { changes: Change[] }) {
  const { t } = useI18n();
  return (
    <ul className="save-changes__list">
      {changes.map((change, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list for this dialog
        <li key={index} className="save-changes__row">
          <span className="save-changes__text">{changeText(t, change)}</span>
          <span className="save-changes__status">
            {t(`dashboards.diff.status.${changeStatus(change)}`)}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** The changes as JSON, line by line: added lines carry `+`, removed ones `-`. */
function JsonDiff({ sections }: { sections: JsonSection[] }) {
  const { t } = useI18n();
  return (
    <div className="json-diff">
      {sections.map((section) => (
        <section key={section.path} className="json-diff__section" aria-label={section.path}>
          <h3 className="json-diff__path">{section.path}</h3>
          <pre className="json-diff__lines">
            {section.lines.map((line, index) =>
              line.kind === "gap" ? (
                // biome-ignore lint/suspicious/noArrayIndexKey: lines of a fixed text
                <span key={index} className="json-diff__line json-diff__line--gap">
                  {"  …"}
                </span>
              ) : (
                // biome-ignore lint/suspicious/noArrayIndexKey: lines of a fixed text
                <span key={index} className={`json-diff__line json-diff__line--${line.kind}`}>
                  <span aria-hidden="true">
                    {line.kind === "added" ? "+ " : line.kind === "removed" ? "- " : "  "}
                  </span>
                  {line.kind === "same" ? null : (
                    <span className="visually-hidden">
                      {t(`dashboards.save.line.${line.kind}`)}{" "}
                    </span>
                  )}
                  {line.text}
                </span>
              ),
            )}
          </pre>
        </section>
      ))}
    </div>
  );
}

function ChangeList({ title, changes }: { title: string; changes: Change[] }) {
  const { t } = useI18n();
  const id = useId();
  return (
    <section className="conflict__side" aria-labelledby={id}>
      <h3 className="conflict__title" id={id}>
        {title}
      </h3>
      {changes.length === 0 ? (
        <p className="field__hint">{t("dashboards.diff.none")}</p>
      ) : (
        <ul className="conflict__list">
          {changes.map((change, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list for this dialog
            <li key={index}>{changeText(t, change)}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Shown when someone else saved while this person was editing: both sets of changes since the
 * version this edit started from, and the choice which to keep. Nothing is merged silently;
 * "save mine as a copy" keeps both.
 */
export function ConflictDialog({
  base,
  mine,
  current,
  busy,
  error,
  onOverwrite,
  onTakeTheirs,
  onSaveCopy,
  onClose,
}: {
  base: DashboardModel;
  mine: DashboardModel;
  current: Dashboard;
  busy: boolean;
  error: string | undefined;
  onOverwrite: () => void;
  onTakeTheirs: () => void;
  /** Keeps their version and saves mine as a new dashboard; absent without the right. */
  onSaveCopy?: (() => void) | undefined;
  onClose: () => void;
}) {
  const { t } = useI18n();
  return (
    <Dialog
      title={t("dashboards.conflict.title")}
      onClose={onClose}
      size="large"
      actions={
        <>
          <button
            type="button"
            className="button button--secondary"
            onClick={onClose}
            data-autofocus
          >
            {t("dashboards.conflict.keepEditing")}
          </button>
          <button type="button" className="button button--secondary" onClick={onTakeTheirs}>
            {t("dashboards.conflict.takeTheirs")}
          </button>
          {onSaveCopy === undefined ? null : (
            <button type="button" className="button button--secondary" onClick={onSaveCopy}>
              {t("dashboards.conflict.saveCopy")}
            </button>
          )}
          <button
            type="button"
            className="button button--primary"
            onClick={onOverwrite}
            disabled={busy}
          >
            {t("dashboards.conflict.overwrite")}
          </button>
        </>
      }
    >
      <p>{t("dashboards.conflict.text", { version: current.version })}</p>
      <FormAlert>{error}</FormAlert>
      <div className="conflict">
        <ChangeList title={t("dashboards.conflict.mine")} changes={diffModels(base, mine)} />
        <ChangeList
          title={t("dashboards.conflict.theirs")}
          changes={diffModels(base, current.model)}
        />
      </div>
    </Dialog>
  );
}
