import { writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

/**
 * The fixture files of an instance, written like ui/e2e/support/fixture-db.ts writes them for
 * the e2e server (without the large `dense` table, which only the drawing budget reads). Keep
 * the two in step when the sales table changes.
 */

export const REGIONS = ["Nord", "Ost", "Süd", "West"] as const;

/** The moment the README screenshots show (ui/e2e/screenshots/demo.ts, SCREENSHOT_NOW). */
export const SCREENSHOT_NOW = Date.UTC(2026, 9, 20, 14, 0, 0);

function sqliteTime(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").replace("Z", "");
}

/** Sales per region every five minutes over the six hours before `now`. */
export function writeSalesDatabase(file: string, now: number): void {
  const db = new DatabaseSync(file);
  try {
    db.exec(`
      CREATE TABLE sales (ts DATETIME NOT NULL, region TEXT NOT NULL, amount REAL NOT NULL);
      CREATE INDEX sales_ts ON sales (ts);
    `);
    const insert = db.prepare("INSERT INTO sales (ts, region, amount) VALUES (?, ?, ?)");
    const start = now - 6 * 60 * 60 * 1000;
    db.exec("BEGIN");
    for (let t = start, step = 0; t <= now; t += 5 * 60 * 1000, step += 1) {
      REGIONS.forEach((region, index) => {
        const amount = 100 * (index + 1) + 20 * Math.sin(step / 6 + index) + step;
        insert.run(sqliteTime(t), region, Math.round(amount * 100) / 100);
      });
    }
    db.exec("COMMIT");
  } finally {
    db.close();
  }
}

export function writeRegionsCsv(file: string): void {
  writeFileSync(file, "region;amount\nNord;1.234,5\nOst;98,25\nSüd;310\n", "utf8");
}
