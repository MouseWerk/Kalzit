import { isRecord } from "../../api/client";
import { useI18n } from "../../i18n/i18n";
import { EMPTY_FIELD_CONFIG } from "../fieldConfig/fieldConfig";
import { Legend, WithLegend } from "../fieldConfig/Legend";
import { LegendTooltipEditor } from "../fieldConfig/LegendTooltipEditor";
import {
  type LegendOptions,
  parseLegend,
  parseTooltip,
  type TooltipOptions,
} from "../fieldConfig/legendOptions";
import { StateTimelinePreview, StatusHistoryPreview } from "../picker/previews";
import { Readout, type ReadoutItem } from "../readout";
import { EmptyPanel, emptyReason } from "../shared";
import { timeTicks } from "../timeseries/series";
import type { PanelEditorProps, PanelPlugin, PanelProps } from "../types";
import { columns, type StateData, segments, stateData } from "./stateData";
import "../viz.css";

export interface StateOptions {
  legend: LegendOptions;
  tooltip: TooltipOptions;
}

function parseOptions(stored: unknown): StateOptions {
  const value = isRecord(stored) ? stored : {};
  return { legend: parseLegend(value), tooltip: parseTooltip(value) };
}

/** Status history shows at most this many columns. */
export const MAX_COLUMNS = 200;
const DAY = 86_400_000;

const percent = (value: number) => `${(Math.min(Math.max(value, 0), 1) * 100).toFixed(3)}%`;

function TimeAxis({ from, to }: { from: number; to: number }) {
  const { language } = useI18n();
  const { ticks, step } = timeTicks(from, to, 5);
  const format = new Intl.DateTimeFormat(
    language,
    step >= DAY ? { day: "2-digit", month: "2-digit" } : { hour: "2-digit", minute: "2-digit" },
  );
  return (
    <div className="state__axis">
      <span />
      <svg className="state__axis-svg" aria-hidden="true">
        {ticks.map((tick) => (
          <text
            key={tick}
            className="ts__label"
            x={percent((tick - from) / (to - from || 1))}
            y="50%"
            textAnchor="middle"
          >
            {format.format(tick)}
          </text>
        ))}
      </svg>
    </div>
  );
}

function StateLegend({ data, options }: { data: StateData; options: LegendOptions }) {
  return (
    <Legend
      options={options}
      columns={[]}
      items={data.legend.map((value) => ({ name: value.text, colorClass: value.colorClass }))}
    />
  );
}

function StateTimelinePanel({
  frames,
  options,
  timeRange,
  title,
  fieldConfig = EMPTY_FIELD_CONFIG,
}: PanelProps<StateOptions>) {
  const { language } = useI18n();
  const data = stateData(frames, fieldConfig, language);
  if (data === null || data.times.length === 0) {
    return <EmptyPanel reason={emptyReason(frames, "noTimeSeries")} />;
  }
  const { from, to } = timeRange;
  const span = to - from || 1;
  const dateTime = new Intl.DateTimeFormat(language, { dateStyle: "short", timeStyle: "medium" });
  const rows = data.rows.map((row) => ({ row, runs: segments(row, data.times, to) }));
  const items: ReadoutItem[] = [];
  const offsets: number[] = [];
  for (const { row, runs } of rows) {
    offsets.push(items.length);
    for (const run of runs) {
      items.push({
        label: `${dateTime.format(run.from)} – ${dateTime.format(run.to)}`,
        rows: [{ name: row.name, value: run.value.text, colorClass: run.value.colorClass }],
      });
    }
  }
  return (
    <WithLegend
      placement={options.legend.placement}
      legend={<StateLegend data={data} options={options.legend} />}
    >
      <Readout title={title} items={items} tooltip={options.tooltip.mode} className="state">
        {(active, hover) => (
          <div className="state__grid">
            {rows.map(({ row, runs }, r) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: rows keep their order
              <div key={r} className="state__row">
                <span className="state__name truncate" title={row.name}>
                  {row.name}
                </span>
                <svg className="state__track" preserveAspectRatio="none" aria-hidden="true">
                  {runs.map((run, i) => {
                    const index = (offsets[r] ?? 0) + i;
                    return (
                      <rect
                        key={run.from}
                        className={`state__cell ${run.value.colorClass}${active === index ? " state__cell--active" : ""}`}
                        x={percent((run.from - from) / span)}
                        y="0"
                        width={percent((run.to - run.from) / span)}
                        height="100%"
                        onPointerEnter={() => hover(index)}
                      />
                    );
                  })}
                </svg>
              </div>
            ))}
            <TimeAxis from={from} to={to} />
          </div>
        )}
      </Readout>
    </WithLegend>
  );
}

function StatusHistoryPanel({
  frames,
  options,
  timeRange,
  title,
  fieldConfig = EMPTY_FIELD_CONFIG,
}: PanelProps<StateOptions>) {
  const { language } = useI18n();
  const data = stateData(frames, fieldConfig, language);
  if (data === null || data.times.length === 0) {
    return <EmptyPanel reason={emptyReason(frames, "noTimeSeries")} />;
  }
  const picked = columns(data, MAX_COLUMNS);
  const width = 1 / picked.length;
  const dateTime = new Intl.DateTimeFormat(language, { dateStyle: "short", timeStyle: "medium" });
  const items: ReadoutItem[] = [];
  data.rows.forEach((row) => {
    for (const column of picked) {
      const value = row.values[column];
      items.push({
        label: dateTime.format(data.times[column] as number),
        rows: [
          {
            name: row.name,
            value: value?.text ?? "–",
            ...(value === null || value === undefined ? {} : { colorClass: value.colorClass }),
          },
        ],
      });
    }
  });
  const first = data.times[picked[0] ?? 0] ?? timeRange.from;
  const last = data.times[picked.at(-1) ?? 0] ?? timeRange.to;
  return (
    <WithLegend
      placement={options.legend.placement}
      legend={<StateLegend data={data} options={options.legend} />}
    >
      <Readout title={title} items={items} tooltip={options.tooltip.mode} className="state">
        {(active, hover) => (
          <div className="state__grid">
            {data.rows.map((row, r) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: rows keep their order
              <div key={r} className="state__row">
                <span className="state__name truncate" title={row.name}>
                  {row.name}
                </span>
                <svg className="state__track" preserveAspectRatio="none" aria-hidden="true">
                  {picked.map((column, c) => {
                    const value = row.values[column];
                    if (value === null || value === undefined) return null;
                    const index = r * picked.length + c;
                    return (
                      <rect
                        key={column}
                        className={`state__cell state__cell--status ${value.colorClass}${active === index ? " state__cell--active" : ""}`}
                        x={percent(c * width)}
                        y="4%"
                        width={percent(width * 0.88)}
                        height="92%"
                        onPointerEnter={() => hover(index)}
                      />
                    );
                  })}
                </svg>
              </div>
            ))}
            <TimeAxis from={first} to={last} />
          </div>
        )}
      </Readout>
    </WithLegend>
  );
}

function StateEditor({ options, onChange }: PanelEditorProps<StateOptions>) {
  return (
    <LegendTooltipEditor
      legend={options.legend}
      tooltip={options.tooltip}
      withValues={false}
      onChange={(legend, tooltip) => onChange({ ...options, legend, tooltip })}
    />
  );
}

export const stateTimelinePanel: PanelPlugin<StateOptions> = {
  type: "state-timeline",
  name: "panels.type.stateTimeline",
  description: "panels.describe.stateTimeline",
  shapes: ["frame"],
  options: parseOptions,
  Panel: StateTimelinePanel,
  Editor: StateEditor,
  fieldOptions: ["standard", "thresholds", "mappings", "color", "overrides"],
  Preview: StateTimelinePreview,
};

export const statusHistoryPanel: PanelPlugin<StateOptions> = {
  type: "status-history",
  name: "panels.type.statusHistory",
  description: "panels.describe.statusHistory",
  shapes: ["frame"],
  options: parseOptions,
  Panel: StatusHistoryPanel,
  Editor: StateEditor,
  fieldOptions: ["standard", "thresholds", "mappings", "color", "overrides"],
  Preview: StatusHistoryPreview,
};
