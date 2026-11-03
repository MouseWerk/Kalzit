export interface Budget {
  start: number;
  language: number;
  languages: string[];
  lazy: string[];
  chunk: number;
  chunks: Record<string, number>;
  total: number;
}

export function chunkName(file: string): string;
export function startFiles(html: string): string[];
export function check(
  budget: Budget,
  sizes: ReadonlyMap<string, number>,
  start: readonly string[],
): { problems: string[]; startSize: number; total: number };
