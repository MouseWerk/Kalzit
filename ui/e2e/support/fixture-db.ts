import { DatabaseSync } from "node:sqlite";

/** The regions of the fixture, in the order a sorted query answers them. */
export const REGIONS = ["Nord", "Ost", "Süd", "West"] as const;

const STEP_MINUTES = 5;
const HOURS = 6;

/** SQLite's own text form for times (`datetime()` writes it), in UTC. */
function sqliteTime(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").replace("Z", "");
}

/**
 * Writes the fixture database: sales per region every five minutes over the last six hours, so
 * Explore's default range (the last hour) and a dashboard's (the last six hours) both find rows.
 * Built at setup time from code, so no binary file is committed and the times are always recent.
 */
export function writeSalesDatabase(file: string, now = Date.now()): void {
  const db = new DatabaseSync(file);
  try {
    db.exec(`
      CREATE TABLE sales (
        ts DATETIME NOT NULL,
        region TEXT NOT NULL,
        amount REAL NOT NULL
      );
      CREATE INDEX sales_ts ON sales (ts);
    `);
    const insert = db.prepare("INSERT INTO sales (ts, region, amount) VALUES (?, ?, ?)");
    const start = now - HOURS * 60 * 60 * 1000;
    db.exec("BEGIN");
    for (let t = start, step = 0; t <= now; t += STEP_MINUTES * 60 * 1000, step += 1) {
      REGIONS.forEach((region, index) => {
        // A deterministic wave per region, so the series differ and never repeat a value.
        const amount = 100 * (index + 1) + 20 * Math.sin(step / 6 + index) + step;
        insert.run(sqliteTime(t), region, Math.round(amount * 100) / 100);
      });
    }
    db.exec("COMMIT");
  } finally {
    db.close();
  }
}
