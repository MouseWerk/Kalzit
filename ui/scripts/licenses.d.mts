export interface LicenseEntry {
  name: string;
  version: string;
  license: string;
  source: "rust" | "npm";
}

export function fromCargoMetadata(metadata: unknown): LicenseEntry[];
export function fromPackageLock(lock: unknown): LicenseEntry[];
export function merge(...lists: LicenseEntry[][]): LicenseEntry[];
export function collect(): LicenseEntry[];
