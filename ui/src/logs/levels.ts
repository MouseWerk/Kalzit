/**
 * The level of a log line (board Logs.dc.html, frame 7): seven steps, the same in every source.
 * Case does not count; syslog numbers (0 to 7) are read too. The original value stays in the
 * line's details, so nothing is lost by the normalization.
 */

export const LEVELS = [
  "critical",
  "error",
  "warning",
  "info",
  "debug",
  "trace",
  "unknown",
] as const;
export type Level = (typeof LEVELS)[number];

const WORDS: Record<string, Level> = {
  critical: "critical",
  crit: "critical",
  fatal: "critical",
  emerg: "critical",
  emergency: "critical",
  alert: "critical",
  panic: "critical",
  error: "error",
  err: "error",
  eror: "error",
  warn: "warning",
  warning: "warning",
  info: "info",
  information: "info",
  informational: "info",
  notice: "info",
  debug: "debug",
  dbg: "debug",
  trace: "trace",
};

/** Syslog severities: 0 emergency, 1 alert, 2 critical, 3 error, 4 warning, 5 notice, 6 info, 7 debug. */
const SYSLOG: readonly Level[] = [
  "critical",
  "critical",
  "critical",
  "error",
  "warning",
  "info",
  "info",
  "debug",
];

/** The level a value names, or "unknown". */
export function normalizeLevel(value: unknown): Level {
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 0 && value < SYSLOG.length
      ? (SYSLOG[value] ?? "unknown")
      : "unknown";
  }
  if (typeof value !== "string") {
    return "unknown";
  }
  const text = value.trim().toLowerCase();
  if (/^[0-7]$/.test(text)) {
    return SYSLOG[Number(text)] ?? "unknown";
  }
  return WORDS[text] ?? "unknown";
}

/** `level=error`, `"level": "warn"`, `severity: 3`: a level key with its value in the text. */
const KEYED =
  /(?:^|[\s{,"'])(?:level|lvl|severity|loglevel|log\.level)["']?\s*[=:]\s*["']?([A-Za-z]+|[0-7])\b/i;
/** A level word in capitals standing on its own, as most log formats write it (`ERROR`, `[WARN]`). */
const WORD =
  /(?:^|[\s[(<|:])(CRITICAL|CRIT|FATAL|EMERG|PANIC|ERROR|ERR|WARNING|WARN|INFO|NOTICE|DEBUG|DBG|TRACE)(?=$|[\s\]):>|,])/;

/** The level written in a line's text, when the source gives none: a level key, else a word. */
export function levelFromText(text: string): { level: Level; raw: string } | null {
  const head = text.length > 2_000 ? text.slice(0, 2_000) : text;
  const keyed = KEYED.exec(head);
  if (keyed?.[1] !== undefined) {
    const level = normalizeLevel(keyed[1]);
    if (level !== "unknown") {
      return { level, raw: keyed[1] };
    }
  }
  const word = WORD.exec(head);
  if (word?.[1] !== undefined) {
    return { level: normalizeLevel(word[1]), raw: word[1] };
  }
  return null;
}
