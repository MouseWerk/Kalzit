import { useId, useState } from "react";
import { FormAlert } from "../../components/FormAlert";
import { TextField } from "../../components/TextField";
import { type Translate, useI18n } from "../../i18n/i18n";
import type { Dashboard } from "./api";
import { type Change, diffModels } from "./diff";
import type { DashboardModel } from "./model";
import { Dialog } from "./ui/Dialog";

/** The server's limit on a version message (docs/api/settings-dashboards.md). */
const MESSAGE_MAX = 500;

export function SaveDialog({
  busy,
  error,
  onSave,
  onClose,
}: {
  busy: boolean;
  error: string | undefined;
  onSave: (message: string) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [message, setMessage] = useState("");
  const formId = useId();
  return (
    <Dialog
      title={t("dashboards.save.title")}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="button button--secondary" onClick={onClose}>
            {t("dashboards.dialog.cancel")}
          </button>
          <button
            type="submit"
            form={formId}
            className="button button--primary"
            disabled={busy}
            aria-disabled={busy}
          >
            {busy ? t("dashboards.save.saving") : t("dashboards.save.submit")}
          </button>
        </>
      }
    >
      <form
        id={formId}
        className="form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          onSave(message.trim());
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
      </form>
    </Dialog>
  );
}

export function changeText(t: Translate, change: Change): string {
  switch (change.kind) {
    case "title":
      return t("dashboards.diff.title", { from: change.from, to: change.to });
    case "timeRange":
      return t("dashboards.diff.timeRange");
    case "refresh":
      return t("dashboards.diff.refresh");
    case "variables":
      return t("dashboards.diff.variables");
    case "panelAdded":
      return t("dashboards.diff.panelAdded", { title: change.title });
    case "panelRemoved":
      return t("dashboards.diff.panelRemoved", { title: change.title });
    case "panelChanged":
      return t("dashboards.diff.panelChanged", { title: change.title });
    case "panelMoved":
      return t("dashboards.diff.panelMoved", { title: change.title });
  }
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
 * version this edit started from, and the choice which to keep. Nothing is merged silently.
 */
export function ConflictDialog({
  base,
  mine,
  current,
  busy,
  error,
  onOverwrite,
  onTakeTheirs,
  onClose,
}: {
  base: DashboardModel;
  mine: DashboardModel;
  current: Dashboard;
  busy: boolean;
  error: string | undefined;
  onOverwrite: () => void;
  onTakeTheirs: () => void;
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
