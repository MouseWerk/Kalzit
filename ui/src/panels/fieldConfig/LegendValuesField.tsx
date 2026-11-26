import { type KeyboardEvent, useId, useRef, useState } from "react";
import { Icon } from "../../components/Icon";
import { type MessageKey, useI18n } from "../../i18n/i18n";
import { isComposingKey } from "../../lib/ime";
import {
  CALC_GROUP_ORDER,
  CALC_GROUPS,
  type Calc,
  type CalcGroup,
  MAX_CALCS,
  PERCENTILE,
  percentileOf,
} from "../calcs";
import { useOptionShown } from "../optionFilter";
import { calcLabel } from "./Legend";

/** One entry of the picker: a calculation, or "Percentile…", which asks for its number. */
type Entry = { group: CalcGroup; calc: Calc | "percentile" };

/**
 * The legend's values as chips with a picker in four groups (ParityEditors board, frame 3):
 * "Häufig", "Verlauf", "Verteilung", "Anzahl", and three more folded below. A search over names
 * and explanations, one line of explanation per value, several picks with the list staying open
 * (Space picks, Escape closes). "Percentile…" asks for a number from 1 to 99 and adds it as a
 * chip such as "p95". At most six values; chips are ordered by dragging, or with Alt and the
 * arrow keys.
 */
export function LegendValuesField({
  values,
  onChange,
}: {
  values: readonly Calc[];
  onChange: (values: Calc[]) => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [more, setMore] = useState(false);
  const [active, setActive] = useState(0);
  const [askPercentile, setAskPercentile] = useState(false);
  const [percent, setPercent] = useState("95");
  const dragged = useRef<number | null>(null);
  const shown = useOptionShown(t("panels.legend.values"), values.length === 0 ? undefined : values);
  if (!shown) return null;
  const full = values.length >= MAX_CALCS;

  const name = (calc: Calc | "percentile") =>
    calc === "percentile"
      ? t("panels.calc.percentileEntry")
      : percentileOf(calc) === null
        ? t(`panels.calc.${calc}` as MessageKey)
        : calcLabel(t, calc);
  const explain = (calc: Calc | "percentile") => t(`panels.calcHint.${calc}` as MessageKey);
  const query = search.trim().toLocaleLowerCase();
  const matches = (calc: Calc | "percentile") =>
    query === "" ||
    name(calc).toLocaleLowerCase().includes(query) ||
    explain(calc).toLocaleLowerCase().includes(query) ||
    calc.toLocaleLowerCase().includes(query);
  const groups = CALC_GROUP_ORDER.filter((g) => g !== "more" || more || query !== "");
  const entries: Entry[] = groups.flatMap((group) =>
    (CALC_GROUPS[group] as readonly (Calc | "percentile")[])
      .filter(matches)
      .map((calc) => ({ group, calc })),
  );

  const toggle = (calc: Calc) => {
    if (values.includes(calc)) {
      onChange(values.filter((v) => v !== calc));
    } else if (!full) {
      onChange([...values, calc]);
    }
  };
  const pick = (entry: Entry | undefined) => {
    if (entry === undefined) return;
    if (entry.calc === "percentile") {
      setAskPercentile(true);
    } else {
      toggle(entry.calc);
    }
  };
  const move = (from: number, to: number) => {
    if (to < 0 || to >= values.length || from === to) return;
    const next = [...values];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item as Calc);
    onChange(next);
  };
  const addPercentile = () => {
    const n = Number(percent);
    if (!Number.isInteger(n) || n < PERCENTILE.min || n > PERCENTILE.max) return;
    const calc = `p${n}` as Calc;
    if (!values.includes(calc) && !full) onChange([...values, calc]);
    setAskPercentile(false);
  };
  const onListKey = (event: KeyboardEvent<HTMLElement>) => {
    // Enter and Escape that confirm or cancel an input method candidate stay with the input.
    if (isComposingKey(event)) return;
    const inPercentile = event.target instanceof HTMLInputElement && event.target.type === "number";
    if ((event.key === "ArrowDown" || event.key === "ArrowUp") && !inPercentile) {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((current) => Math.min(Math.max(current + step, 0), entries.length - 1));
    } else if (event.key === " " || event.key === "Enter") {
      if (event.target instanceof HTMLInputElement && event.key === " ") return;
      event.preventDefault();
      pick(entries[active]);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    }
  };
  const percentInvalid =
    !/^\d+$/.test(percent) || Number(percent) < PERCENTILE.min || Number(percent) > PERCENTILE.max;

  return (
    <div className="field legend-values" data-option="">
      <span className="field__label" id={`${id}-label`}>
        {t("panels.legend.values")}
      </span>
      <p className="field__hint" id={`${id}-hint`}>
        {t("panels.legend.valuesHint")}
      </p>
      <span className="visually-hidden" id={`${id}-move`}>
        {t("panels.legend.moveHint")}
      </span>
      <ul className="legend-values__chips" aria-labelledby={`${id}-label`}>
        {values.map((calc, index) => (
          <li
            key={calc}
            className="legend-values__chip"
            draggable
            onDragStart={() => {
              dragged.current = index;
            }}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              if (dragged.current !== null) move(dragged.current, index);
              dragged.current = null;
            }}
          >
            <button
              type="button"
              className="legend-values__name"
              title={explain(percentileOf(calc) === null ? calc : "percentile")}
              aria-describedby={`${id}-move`}
              onKeyDown={(event) => {
                if (!event.altKey) return;
                if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                  event.preventDefault();
                  move(index, index + (event.key === "ArrowLeft" ? -1 : 1));
                }
              }}
            >
              {name(calc)}
            </button>
            <button
              type="button"
              className="legend-values__remove"
              aria-label={t("panels.legend.removeValue", { value: name(calc) })}
              onClick={() => onChange(values.filter((v) => v !== calc))}
            >
              <Icon name="close" />
            </button>
          </li>
        ))}
        <li>
          <button
            type="button"
            className="button button--secondary button--small"
            aria-expanded={open}
            aria-controls={`${id}-picker`}
            onClick={() => setOpen((current) => !current)}
          >
            <Icon name="plus" />
            {t("panels.legend.addValue")}
          </button>
        </li>
      </ul>
      {full ? (
        <p className="field__hint">{t("panels.legend.valuesFull", { max: MAX_CALCS })}</p>
      ) : null}
      {!open ? null : (
        // biome-ignore lint/a11y/noStaticElementInteractions: the keys of the search and the list go through here
        <div className="legend-values__picker" id={`${id}-picker`} onKeyDown={onListKey}>
          <input
            className="input"
            type="search"
            value={search}
            placeholder={t("panels.legend.searchValue")}
            aria-label={t("panels.legend.searchValue")}
            aria-controls={`${id}-list`}
            aria-activedescendant={entries[active] === undefined ? undefined : `${id}-${active}`}
            // biome-ignore lint/a11y/noAutofocus: the picker opened on purpose; typing searches right away
            autoFocus
            onChange={(event) => {
              setSearch(event.currentTarget.value);
              setActive(0);
            }}
          />
          <div
            className="legend-values__list"
            id={`${id}-list`}
            role="listbox"
            aria-multiselectable="true"
            aria-label={t("panels.legend.values")}
          >
            {groups.map((group) => {
              const own = entries
                .map((entry, index) => ({ entry, index }))
                .filter(({ entry }) => entry.group === group);
              if (own.length === 0) return null;
              return (
                // biome-ignore lint/a11y/useSemanticElements: a group of options inside a listbox, not of form fields
                <div key={group} role="group" aria-labelledby={`${id}-group-${group}`}>
                  <span className="legend-values__group" id={`${id}-group-${group}`}>
                    {t(`panels.calcGroup.${group}`)}
                  </span>
                  {own.map(({ entry, index }) => {
                    const selected =
                      entry.calc === "percentile"
                        ? values.some((v) => percentileOf(v) !== null)
                        : values.includes(entry.calc);
                    return (
                      // biome-ignore lint/a11y/useKeyWithClickEvents: the keys are handled on the picker
                      <div
                        key={entry.calc}
                        id={`${id}-${index}`}
                        role="option"
                        tabIndex={-1}
                        aria-selected={selected}
                        aria-disabled={full && !selected && entry.calc !== "percentile"}
                        className={`legend-values__option${index === active ? " legend-values__option--active" : ""}`}
                        onClick={() => {
                          setActive(index);
                          pick(entry);
                        }}
                      >
                        <span className="legend-values__check" aria-hidden="true">
                          {selected ? <Icon name="check" /> : null}
                        </span>
                        <span className="legend-values__option-name">{name(entry.calc)}</span>
                        <span className="legend-values__explain">{explain(entry.calc)}</span>
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
          {more || query !== "" ? null : (
            <button
              type="button"
              className="button button--ghost button--small"
              onClick={() => setMore(true)}
            >
              {t("panels.legend.moreValues")}
            </button>
          )}
          {askPercentile ? (
            <div className="legend-values__percentile">
              <label className="field__label" htmlFor={`${id}-p`}>
                {t("panels.legend.percentileNumber")}
              </label>
              <input
                id={`${id}-p`}
                className="input"
                type="number"
                inputMode="numeric"
                min={PERCENTILE.min}
                max={PERCENTILE.max}
                step={1}
                value={percent}
                aria-invalid={percentInvalid}
                onChange={(event) => setPercent(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !isComposingKey(event)) {
                    event.preventDefault();
                    event.stopPropagation();
                    addPercentile();
                  }
                }}
              />
              <button
                type="button"
                className="button button--secondary button--small"
                disabled={percentInvalid || full}
                onClick={addPercentile}
              >
                {t("panels.legend.addPercentile")}
              </button>
            </div>
          ) : null}
          <p className="legend-values__status" role="status">
            {t("panels.legend.chosen", { count: values.length })}
          </p>
        </div>
      )}
    </div>
  );
}
