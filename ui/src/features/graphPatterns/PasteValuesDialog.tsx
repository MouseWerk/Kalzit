import "./patterns.css";
import { useId, useState } from "react";
import type { ParameterType } from "../../api/generated/shapes";
import { Select } from "../../components/Select";
import { useI18n } from "../../i18n/i18n";
import { Dialog } from "../dashboards/ui/Dialog";
import { DEFAULT_MAX_VALUES, readList } from "./pattern";
import { TYPE_TEXT } from "./sentence";

const LIST_TYPES: ParameterType[] = ["stringList", "integerList", "floatList", "idList"];

/**
 * "Werte einfügen" (board Graph083, frame 7): a column from a table, a list or a CSV line becomes
 * one list variable. Kalzit splits, leaves out repeats and empty lines, checks the type and says
 * what it did; the values travel as a parameter, never as query text.
 */
export function PasteValuesDialog({
  name,
  type,
  initial,
  onAccept,
  onClose,
}: {
  name: string;
  type: ParameterType;
  initial: string;
  onAccept: (values: string[], type: ParameterType) => void;
  onClose: () => void;
}) {
  const { t, language } = useI18n();
  const id = useId();
  const [text, setText] = useState(initial);
  const [listType, setListType] = useState<ParameterType>(type);
  const read = readList(text, listType);
  const tooMany = read.values.length > DEFAULT_MAX_VALUES;
  const number = (n: number) => n.toLocaleString(language);
  const accept = (values: string[]) => {
    onAccept(values, listType);
    onClose();
  };
  return (
    <Dialog
      title={t("graphPatterns.paste.title", { name })}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="button button--secondary" onClick={onClose}>
            {t("graphPatterns.paste.cancel")}
          </button>
          {read.wrong.length > 0 ? (
            <button
              type="button"
              className="button button--secondary"
              onClick={() => accept(read.values.filter((v) => !read.wrong.includes(v)))}
            >
              {t("graphPatterns.paste.withoutWrong", { count: read.wrong.length })}
            </button>
          ) : null}
          {tooMany ? (
            <button
              type="button"
              className="button button--secondary"
              onClick={() => accept(read.values.slice(0, DEFAULT_MAX_VALUES))}
            >
              {t("graphPatterns.paste.first", { max: number(DEFAULT_MAX_VALUES) })}
            </button>
          ) : null}
          <button
            type="button"
            className="button button--primary"
            disabled={read.values.length === 0 || read.wrong.length > 0 || tooMany}
            onClick={() => accept(read.values)}
          >
            {t("graphPatterns.paste.accept")}
          </button>
        </>
      }
    >
      <div className="form">
        <div className="field">
          <label className="field__label" htmlFor={`${id}-values`}>
            {t("graphPatterns.paste.label")}
          </label>
          <p className="field__hint" id={`${id}-hint`}>
            {t("graphPatterns.paste.hint")}
          </p>
          <textarea
            id={`${id}-values`}
            className="input input--mono pattern-paste__values"
            rows={8}
            value={text}
            aria-describedby={`${id}-hint ${id}-read`}
            onChange={(event) => setText(event.currentTarget.value)}
            data-autofocus
          />
        </div>
        <div className="field">
          <label className="field__label" htmlFor={`${id}-type`}>
            {t("graphPatterns.paste.type")}
          </label>
          <Select
            id={`${id}-type`}
            value={listType}
            onChange={(v) => setListType(v as ParameterType)}
          >
            {LIST_TYPES.map((value) => (
              <option key={value} value={value}>
                {t(TYPE_TEXT[value])}
              </option>
            ))}
          </Select>
        </div>
        <div id={`${id}-read`} role="status" className="pattern-paste__read">
          {text.trim() === "" ? null : (
            <p>
              {t("graphPatterns.paste.read", {
                count: number(read.values.length),
                duplicates: number(read.duplicates),
                empty: number(read.empty),
              })}{" "}
              {t("graphPatterns.paste.separators")}
            </p>
          )}
          {read.wrong.length === 0 ? null : (
            <p className="field__error">
              {t("graphPatterns.paste.wrong", {
                count: read.wrong.length,
                values: read.wrong
                  .slice(0, 5)
                  .map((v) => (language === "de" ? `„${v}“` : `“${v}”`))
                  .join(", "),
              })}
            </p>
          )}
          {tooMany ? (
            <p className="field__error">
              {t("graphPatterns.paste.tooMany", { max: number(DEFAULT_MAX_VALUES) })}
            </p>
          ) : null}
        </div>
        <p className="field__hint">{t("graphPatterns.paste.never")}</p>
      </div>
    </Dialog>
  );
}
