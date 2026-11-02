import { useEffect, useId, useRef, useState } from "react";
import { Icon } from "../../components/Icon";
import { IconButton, WithTooltip } from "../../components/IconButton";
import { useI18n } from "../../i18n/i18n";
import { useTimeSettings } from "../../lib/timeSettings";
import type { RangePopover } from "./RangePopover";
import { useRangeClipboard } from "./rangeClipboard";
import { rangeLabel, zoneOffset } from "./rangeLabel";
import { rememberRange } from "./recentRanges";
import { shiftRange, type TextRange, zoomOutRange } from "./timeRange";
import { type TimeShortcut, useTimeShortcuts } from "./timeShortcuts";
import "./dashboards.css";
import "./toolbar.css";

type Popover = typeof RangePopover;

// The popover is a chunk of its own (RangePopover.tsx): a page with a picker fetches it once the
// picker shows, in the background, and opening the picker renders it as soon as it is there.
let loadedPopover: Popover | null = null;
let loadingPopover: Promise<Popover> | null = null;

function loadPopover(): Promise<Popover> {
  loadingPopover ??= import("./RangePopover").then(
    (module) => {
      loadedPopover = module.RangePopover;
      return module.RangePopover;
    },
    (error: unknown) => {
      // A failed fetch is tried again with the next picker that shows or opens.
      loadingPopover = null;
      throw error;
    },
  );
  return loadingPopover;
}

/** The popover component once loaded; starts the download when the picker first shows. */
function usePopover(open: boolean): Popover | null {
  const [popover, setPopover] = useState<Popover | null>(() => loadedPopover);
  useEffect(() => {
    if (popover !== null) {
      return;
    }
    let live = true;
    loadPopover().then(
      (component) => {
        // Rendered at once when it is opened; while closed it waits for the next render.
        if (live && open) {
          setPopover(() => component);
        }
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [open, popover]);
  return popover ?? (open ? loadedPopover : null);
}

interface TimeRangePickerProps {
  value: TextRange;
  onChange: (range: TextRange) => void;
  /** What the range is for, in the button's accessible name ("Default time range: ..."). */
  name?: string;
  /** The signed-in account: the ranges it applied are offered again (kept in this browser). */
  userId?: string | undefined;
  /** Whether the zone in effect is the dashboard's own (named in the footer). */
  dashboardZone?: boolean;
  /** Shows the zone's offset in the button, after the range. */
  showZone?: boolean;
  /** The dashboard's now delay ("1m"): the preview of a typed range resolves with it. */
  nowDelay?: string | undefined;
}

/**
 * The time range button and its popover: quick ranges with a search, recently used ranges,
 * an absolute range typed or picked on a calendar, copy and paste. The popover is not modal:
 * Escape, a click outside or leaving it with Tab closes it.
 */
export function TimeRangePicker({
  value,
  onChange,
  name,
  userId,
  dashboardZone = false,
  showZone = false,
  nowDelay,
}: TimeRangePickerProps) {
  const { t, language, timeZone } = useI18n();
  const [open, setOpen] = useState(false);
  const Popover = usePopover(open);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverId = useId();
  const label = rangeLabel(t, language, value, timeZone);
  const zone = showZone ? zoneOffset(language, timeZone) : "";
  // The name holds what the button shows, the zone included.
  const shown = zone === "" ? label : `${label} ${zone}`;
  const accessible =
    name === undefined
      ? t("dashboards.time.buttonLabel", { range: shown })
      : t("dashboards.time.buttonFor", { name, range: label });
  return (
    <>
      <WithTooltip label={t("dashboards.time.title")}>
        <button
          ref={buttonRef}
          type="button"
          className="button button--ghost time-picker__button"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? popoverId : undefined}
          aria-label={accessible}
          onClick={() => setOpen((o) => !o)}
        >
          <Icon name="clock" />
          <span className="time-picker__label truncate" title={label}>
            {label}
          </span>
          {/* A space, so the text reads as the name does: "Last 6 hours GMT+2". */}
          {zone === "" ? null : " "}
          {zone === "" ? null : <span className="time-picker__zone-tag">{zone}</span>}
          <Icon name="chevronDown" className="time-picker__chevron" />
        </button>
      </WithTooltip>
      {open && Popover !== null ? (
        <Popover
          id={popoverId}
          anchor={buttonRef}
          value={value}
          userId={userId}
          dashboardZone={dashboardZone}
          nowDelay={nowDelay}
          onClose={(returnFocus) => {
            setOpen(false);
            if (returnFocus) {
              buttonRef.current?.focus();
            }
          }}
          onApply={(range) => {
            setOpen(false);
            buttonRef.current?.focus();
            if (userId !== undefined) {
              rememberRange(userId, range);
            }
            onChange(range);
          }}
        />
      ) : null}
    </>
  );
}

interface TimeControlsProps {
  value: TextRange;
  onChange: (range: TextRange) => void;
  userId?: string | undefined;
  dashboardZone?: boolean;
  /** Listen for the time shortcuts (t and Left, Right, z, c, v). */
  shortcuts?: boolean;
  /** Only the range button (the panel editor's bar); the shortcuts still work. */
  compact?: boolean;
  /** The dashboard's now delay, for the picker's preview. */
  nowDelay?: string | undefined;
}

/**
 * The time range with its neighbors: move back, the picker, move forward, zoom out. The same
 * controls in the dashboard toolbar and in the panel editor's bar.
 */
export function TimeControls({
  value,
  onChange,
  userId,
  dashboardZone = false,
  shortcuts = false,
  compact = false,
  nowDelay,
}: TimeControlsProps) {
  const { t } = useI18n();
  const settings = useTimeSettings();
  const clipboard = useRangeClipboard();

  function apply(next: TextRange | null) {
    if (next !== null) {
      onChange(next);
    }
  }

  function run(shortcut: TimeShortcut) {
    switch (shortcut) {
      case "back":
        apply(shiftRange(value, -1, Date.now(), settings));
        break;
      case "forward":
        apply(shiftRange(value, 1, Date.now(), settings));
        break;
      case "zoomOut":
        apply(zoomOutRange(value, Date.now(), settings));
        break;
      case "copy":
        void clipboard.copy(value);
        break;
      case "paste":
        void clipboard.paste().then((range) => {
          if (range !== null) {
            if (userId !== undefined) {
              rememberRange(userId, range);
            }
            onChange(range);
          }
        });
        break;
    }
  }
  useTimeShortcuts(shortcuts, run);

  if (compact) {
    return (
      <TimeRangePicker
        value={value}
        onChange={onChange}
        userId={userId}
        dashboardZone={dashboardZone}
        nowDelay={nowDelay}
      />
    );
  }
  return (
    // biome-ignore lint/a11y/useSemanticElements: a group of buttons, not a set of form fields
    <div className="time-controls" role="group" aria-label={t("toolbar.time.controls")}>
      <IconButton
        icon="chevronsLeft"
        label={t("toolbar.time.back")}
        shortcut={["t", "←"]}
        ariaShortcut="t ArrowLeft"
        className="time-controls__step"
        onClick={() => run("back")}
      />
      <TimeRangePicker
        value={value}
        onChange={onChange}
        userId={userId}
        dashboardZone={dashboardZone}
        nowDelay={nowDelay}
        showZone
      />
      <IconButton
        icon="chevronsRight"
        label={t("toolbar.time.forward")}
        shortcut={["t", "→"]}
        ariaShortcut="t ArrowRight"
        className="time-controls__step"
        onClick={() => run("forward")}
      />
      <IconButton
        icon="zoomOut"
        label={t("toolbar.time.zoomOut")}
        shortcut={["t", "z"]}
        ariaShortcut="t z"
        onClick={() => run("zoomOut")}
      />
    </div>
  );
}
