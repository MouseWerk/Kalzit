import { useI18n } from "../../../i18n/i18n";
import "./sourceEditors.css";

/**
 * Fields of a stored query that the server would refuse (unknown, or of the wrong type). They are
 * named, the query does not run, and the user removes them on purpose instead of losing them
 * silently.
 */
export function StoredProblems({
  problems,
  onRemove,
}: {
  problems: readonly string[];
  onRemove: () => void;
}) {
  const { t } = useI18n();
  if (problems.length === 0) {
    return null;
  }
  return (
    <div className="source-query__status" role="alert">
      <span className="field__error">
        {t("datasources.editor.storedProblems", { fields: problems.join(", ") })}
      </span>
      <button type="button" className="button button--secondary button--small" onClick={onRemove}>
        {t("datasources.editor.storedProblemsRemove")}
      </button>
    </div>
  );
}
