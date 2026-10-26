import { Link } from "@tanstack/react-router";
import { useEffect, useEffectEvent } from "react";
import { folderTrail } from "../../components/Breadcrumbs";
import { Icon } from "../../components/Icon";
import { ToolbarMenu } from "../../components/ToolbarMenu";
import { useI18n } from "../../i18n/i18n";
import { relativeTime } from "../../shell/startData";
import type { Folder } from "../dashboards/api";
import type { Analysis } from "./api";
import "./analyses.css";

/**
 * The saved analysis's place and name above Explore's toolbar: the folders as links into the
 * list, the title, and a quiet "Changed" while the editor differs from the saved version.
 */
export function SavedHeading({
  analysis,
  folders,
  dirty,
}: {
  analysis: Analysis;
  folders: readonly Folder[];
  dirty: boolean;
}) {
  const { t } = useI18n();
  const trail = folderTrail(folders, analysis.folderId);
  return (
    <div className="explore-saved">
      <nav className="explore-saved__trail" aria-label={t("analyses.explore.place")}>
        <Link to="/explore/saved" search={{}}>
          {t("analyses.nav")}
        </Link>
        {trail.map((folder) => (
          <span key={folder.id} className="explore-saved__step">
            <span aria-hidden="true">/</span>
            <Link to="/explore/saved" search={{ folder: folder.id }}>
              {folder.name}
            </Link>
          </span>
        ))}
        <span aria-hidden="true">/</span>
      </nav>
      <h2 className="explore-saved__title">{analysis.title}</h2>
      {dirty ? (
        <span className="analysis-changed" title={t("analyses.explore.changedHint")}>
          <span className="analysis-changed__dot" aria-hidden="true" />
          {t("analyses.explore.changed")}
        </span>
      ) : null}
    </div>
  );
}

/** "Saved 6 min ago by you", next to the save button. */
export function SavedAgo({ analysis, meId }: { analysis: Analysis; meId: string }) {
  const { t, language } = useI18n();
  const relative = new Intl.RelativeTimeFormat(language, { numeric: "auto", style: "short" });
  const when = relativeTime(relative, analysis.updatedAt, Date.now(), t("analyses.justNow"));
  return (
    <span className="explore-saved__ago">
      {analysis.updatedBy === meId
        ? t("analyses.explore.savedByYou", { when })
        : t("analyses.explore.saved", { when })}
    </span>
  );
}

export interface SaveActions {
  save: () => void;
  saveAs: () => void;
  rename: () => void;
  move: () => void;
  versions: () => void;
  discard: () => void;
}

/**
 * Save, and once the analysis is saved its menu beside it: save as, rename, move, versions and
 * discarding the changes. Saving over the stored version needs the right to write it; without
 * it Save becomes "Save as".
 */
export function SaveControls({
  saved,
  dirty,
  mayWrite,
  busy,
  actions,
}: {
  saved: Analysis | null;
  dirty: boolean;
  mayWrite: boolean;
  busy: boolean;
  actions: SaveActions;
}) {
  const { t } = useI18n();
  const button = (
    <button
      type="button"
      className="button button--secondary explore-save__main"
      onClick={saved !== null && !mayWrite ? actions.saveAs : actions.save}
      disabled={busy}
      aria-keyshortcuts="Control+S"
      title={t("analyses.keys.save")}
    >
      <Icon name="save" />
      {saved !== null && !mayWrite ? t("analyses.menu.saveAs") : t("analyses.explore.save")}
    </button>
  );
  if (saved === null) {
    return button;
  }
  return (
    <div className="explore-save">
      {button}
      <ToolbarMenu
        label={t("analyses.explore.more")}
        icon="chevronDown"
        className="explore-save__more"
        entries={[
          {
            key: "save",
            label: t("analyses.explore.save"),
            icon: "save",
            shortcut: t("analyses.keys.save"),
            disabled: !mayWrite || busy,
            onSelect: actions.save,
          },
          {
            key: "saveAs",
            label: t("analyses.menu.saveAs"),
            icon: "copy",
            shortcut: t("analyses.keys.saveAs"),
            onSelect: actions.saveAs,
          },
          {
            key: "rename",
            label: t("analyses.menu.rename"),
            icon: "edit",
            disabled: !mayWrite,
            onSelect: actions.rename,
          },
          {
            key: "move",
            label: t("analyses.menu.move"),
            icon: "folder",
            disabled: !mayWrite,
            onSelect: actions.move,
          },
          {
            key: "versions",
            label: t("analyses.menu.versions"),
            icon: "history",
            onSelect: actions.versions,
          },
          { kind: "separator", key: "sep" },
          {
            key: "discard",
            label: t("analyses.menu.discard"),
            icon: "refresh",
            disabled: !dirty,
            onSelect: actions.discard,
          },
        ]}
      />
    </div>
  );
}

/**
 * Explore's keys for saved analyses: Ctrl+S saves, Ctrl+Shift+S saves as, Ctrl+O opens (Cmd on
 * macOS). Not while a dialog is open, which owns the keyboard then.
 */
export function SaveShortcuts({
  onSave,
  onSaveAs,
  onOpen,
}: {
  onSave: () => void;
  onSaveAs: () => void;
  onOpen: (() => void) | undefined;
}) {
  const save = useEffectEvent(onSave);
  const saveAs = useEffectEvent(onSaveAs);
  const open = useEffectEvent(() => onOpen?.());
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.defaultPrevented) {
        return;
      }
      // A dialog owns the keyboard; a completion list in the editor does not stop saving.
      if (document.querySelector('[aria-modal="true"]') !== null) {
        return;
      }
      const key = event.key.toLowerCase();
      if (key === "s") {
        event.preventDefault();
        if (event.shiftKey) {
          saveAs();
        } else {
          save();
        }
      } else if (key === "o" && !event.shiftKey) {
        event.preventDefault();
        open();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);
  return null;
}
