import { useId } from "react";
import { Select } from "../../components/Select";
import { type Translate, useI18n } from "../../i18n/i18n";
import { isNumeric } from "../frame";
import { CheckboxField } from "../shared";
import type { TableColumn } from "../types";
import {
  calcFits,
  FOOTER_CALCS,
  FOOTER_PERCENTILES,
  type FooterCalc,
  type FooterColumn,
  MAX_FOOTER_COLUMNS,
  parseFooterCalc,
  percentileOf,
  type TableFooter,
} from "./footer";

/** A calculation's name in the picker. */
function calcName(t: Translate, calc: FooterCalc): string {
  const p = percentileOf(calc);
  return p === null
    ? t(`panels.calc.${calc as Exclude<FooterCalc, `p${number}`>}`)
    : t("panels.calc.percentile", { p });
}

/** The calculations offered for a column of this type, numbers ones only for numbers. */
function calcsFor(type: TableColumn["type"] | null): FooterCalc[] {
  const all: FooterCalc[] = [...FOOTER_CALCS, ...FOOTER_PERCENTILES];
  return type === null ? all : all.filter((calc) => calcFits(calc, type));
}

/**
 * The footer's options (ParityEditors board, frame 12): on or off, over which rows, one
 * calculation for every number column, and one per column. Columns come from the preview; a
 * stored entry for a column the preview does not show stays listed, so it can be removed.
 */
export function FooterEditor({
  footer,
  columns,
  onChange,
}: {
  footer: TableFooter;
  columns: readonly TableColumn[];
  onChange: (footer: TableFooter) => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const known = new Set(columns.map((c) => c.name));
  const rows: { name: string; type: TableColumn["type"] | null }[] = [
    ...columns.map((c) => ({ name: c.name, type: c.type })),
    ...footer.columns
      .filter((c) => !known.has(c.column))
      .map((c) => ({ name: c.column, type: null })),
  ];
  const own = (name: string) => footer.columns.find((c) => c.column === name)?.calc;
  function setColumn(name: string, value: string) {
    const calc = parseFooterCalc(value);
    const rest = footer.columns.filter((c) => c.column !== name);
    const next: FooterColumn[] = calc === null ? rest : [...rest, { column: name, calc }];
    onChange({ ...footer, columns: next.slice(0, MAX_FOOTER_COLUMNS) });
  }
  return (
    <>
      <CheckboxField
        label={t("panels.table.footer.show")}
        hint={t("panels.table.footer.showHint")}
        checked={footer.show}
        onChange={(show) => onChange({ ...footer, show })}
      />
      {footer.show ? (
        <>
          <div className="field">
            <label className="field__label" htmlFor={`${id}-over`}>
              {t("panels.table.footer.over")}
            </label>
            <p className="field__hint" id={`${id}-over-hint`}>
              {t("panels.table.footer.overHint")}
            </p>
            <Select
              id={`${id}-over`}
              aria-describedby={`${id}-over-hint`}
              value={footer.over}
              onChange={(over) =>
                onChange({ ...footer, over: over === "filtered" ? "filtered" : "all" })
              }
            >
              <option value="all">{t("panels.table.footer.overAllRows")}</option>
              <option value="filtered">{t("panels.table.footer.overFilteredRows")}</option>
            </Select>
          </div>
          <div className="field">
            <label className="field__label" htmlFor={`${id}-numbers`}>
              {t("panels.table.footer.numbers")}
            </label>
            <Select
              id={`${id}-numbers`}
              value={footer.numbers ?? ""}
              onChange={(value) => {
                const calc = parseFooterCalc(value);
                const { numbers: _old, ...rest } = footer;
                onChange(calc === null ? rest : { ...rest, numbers: calc });
              }}
            >
              <option value="">{t("panels.table.footer.none")}</option>
              {calcsFor("number").map((calc) => (
                <option key={calc} value={calc}>
                  {calcName(t, calc)}
                </option>
              ))}
            </Select>
          </div>
          {rows.length === 0 ? (
            <p className="field__hint">{t("panels.table.footer.noColumns")}</p>
          ) : (
            <fieldset className="table-footer-editor">
              <legend className="field__label">{t("panels.table.footer.perColumn")}</legend>
              {rows.map((row, index) => {
                const value = own(row.name);
                const inherited =
                  value === undefined && footer.numbers !== undefined && row.type !== null
                    ? isNumeric(row.type)
                    : false;
                return (
                  <div key={row.name} className="table-footer-editor__row">
                    <label className="truncate" htmlFor={`${id}-col-${index}`} title={row.name}>
                      {row.name}
                    </label>
                    <Select
                      id={`${id}-col-${index}`}
                      value={value ?? ""}
                      onChange={(next) => setColumn(row.name, next)}
                    >
                      <option value="">
                        {inherited && footer.numbers !== undefined
                          ? t("panels.table.footer.asNumbers", {
                              calc: calcName(t, footer.numbers),
                            })
                          : t("panels.table.footer.none")}
                      </option>
                      {calcsFor(row.type).map((calc) => (
                        <option key={calc} value={calc}>
                          {calcName(t, calc)}
                        </option>
                      ))}
                    </Select>
                  </div>
                );
              })}
            </fieldset>
          )}
        </>
      ) : null}
    </>
  );
}
