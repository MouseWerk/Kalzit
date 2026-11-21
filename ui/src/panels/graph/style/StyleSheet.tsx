import { IconButton } from "../../../components/IconButton";
import { useI18n } from "../../../i18n/i18n";
import { StyleEditor, type StyleEditorProps } from "./StyleEditor";
import "./style.css";

/**
 * The sheet "Stil" of a graph panel, opened by the button of the same name in the panel's head
 * (Graph081 board, frame 8): the same rule list as in the panel editor, at the side of the
 * drawing. While a dashboard is viewed, a change there applies to this view only and is not
 * saved; in the panel editor's preview it changes the panel (`saves`).
 */
export function StyleSheet({
  saves,
  changed,
  onReset,
  onClose,
  ...editor
}: StyleEditorProps & {
  /** Whether a change is the panel's own (the panel editor), not only this view's. */
  saves: boolean;
  /** Whether this view differs from the panel's saved rules. */
  changed: boolean;
  onReset: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  return (
    <section className="graph__details graph-style-sheet" aria-label={t("graphStyle.sheet.label")}>
      <div className="graph-style-sheet__head">
        <h3 className="graph__details-title">{t("graphStyle.title")}</h3>
        <IconButton icon="close" label={t("graphStyle.sheet.close")} onClick={onClose} />
      </div>
      {saves ? null : (
        <p className="field__hint">
          {t("graphStyle.sheet.viewOnly")}{" "}
          {changed ? (
            <button type="button" className="button button--ghost button--small" onClick={onReset}>
              {t("graphStyle.sheet.reset")}
            </button>
          ) : null}
        </p>
      )}
      <StyleEditor {...editor} />
    </section>
  );
}
