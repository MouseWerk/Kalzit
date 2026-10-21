import type { MessageKey } from "../../i18n/i18n";

/** Automatic refresh intervals offered; 0 is off. */
export const REFRESH_CHOICES: readonly { seconds: number; label: MessageKey }[] = [
  { seconds: 0, label: "dashboards.refresh.off" },
  { seconds: 10, label: "dashboards.refresh.10s" },
  { seconds: 30, label: "dashboards.refresh.30s" },
  { seconds: 60, label: "dashboards.refresh.1m" },
  { seconds: 300, label: "dashboards.refresh.5m" },
  { seconds: 900, label: "dashboards.refresh.15m" },
  { seconds: 3600, label: "dashboards.refresh.1h" },
];
