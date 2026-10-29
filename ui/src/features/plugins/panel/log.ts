import type { LogLevel } from "./protocol";

/**
 * The browser console, where a panel plugin's log lines and the host's notes about its events
 * (dropped, refused, not acted on) go, each tagged with the plugin id. For the plugin's author;
 * viewers see a panel's failures in the panel itself.
 */
export function panelConsole(id: string, level: LogLevel, text: string): void {
  const line = `[panel ${id}] ${text}`;
  // biome-ignore-start lint/suspicious/noConsole: the panel's log is meant for the console
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else if (level === "info") {
    console.info(line);
  } else {
    console.debug(line);
  }
  // biome-ignore-end lint/suspicious/noConsole: the panel's log is meant for the console
}
