/** A size in bytes as the language writes it, in steps of 1000 up to gigabytes ("1.5 MB"). */
export function formatBytes(bytes: number, language: string): string {
  const units = ["byte", "kilobyte", "megabyte", "gigabyte"] as const;
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return new Intl.NumberFormat(language, {
    style: "unit",
    unit: units[unit],
    maximumFractionDigits: unit === 0 ? 0 : 1,
  }).format(value);
}
