export interface LicenseEntry {
  name: string;
  version: string;
  license: string;
  source: "rust" | "npm";
  /** Where the package's files are; not part of the written list. */
  readonly dir?: string | undefined;
}

export const SEE_FILE: string;
export function fromCargoMetadata(metadata: unknown): LicenseEntry[];
export function fromPackageLock(lock: unknown, root?: string): LicenseEntry[];
export function merge(...lists: LicenseEntry[][]): LicenseEntry[];
export function licenseFiles(dir: string | undefined): { name: string; text: string }[];
export function buildNotices(entries: readonly LicenseEntry[]): string;
export function isStrict(env?: Record<string, string | undefined>): boolean;
export function toAscii(text: string): string;
