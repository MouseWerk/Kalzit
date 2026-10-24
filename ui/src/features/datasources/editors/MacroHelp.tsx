import { type MessageKey, useI18n } from "../../../i18n/i18n";
import "./editors.css";

/** The macros a query form takes, with what each one becomes, folded away below the editor. */
export function MacroHelp({
  macros,
  lead,
}: {
  macros: { name: string; help: MessageKey }[];
  lead: MessageKey;
}) {
  const { t } = useI18n();
  return (
    <details className="query-editor__help">
      <summary>{t("datasources.editor.macros")}</summary>
      <p className="field__hint">{t(lead)}</p>
      <dl className="query-editor__macros">
        {macros.map((macro) => (
          <div key={macro.name}>
            <dt>
              <code>{macro.name}</code>
            </dt>
            <dd>{t(macro.help)}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}
