import { DatabaseSync } from "node:sqlite";

/**
 * The example data of the gallery renders: a fictional data center, "Site Basalt", with three
 * halls. Every name, vendor and figure is invented and computed, so a rerun draws the same
 * pictures. The SQLite metrics and the OpenSearch log events are written here; MongoDB and Neo4j
 * are seeded from ui/e2e/fixtures/gallery-datacenter.js and gallery-datacenter.cypher.
 */

/** The moment the renders show; the metrics cover the 24 hours before it. */
export const GALLERY_NOW = Date.UTC(2026, 9, 20, 14, 0, 0);

export const HALLS = ["Hall A", "Hall B", "Hall C"] as const;
const ROWS = 4;
const RACKS_PER_ROW = 6;
const STEP_MINUTES = 5;
const HOURS = 24;

/** The MongoDB database of gallery-datacenter.js and its read-only login. */
export const GALLERY_MONGO = {
  database: "kalzit_gallery",
  user: "kalzit_gallery_reader",
  password: "kalzit-gallery-reader",
} as const;

/** SQLite's own text form for times, in UTC, as the e2e fixture writes them. */
function sqliteTime(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").replace("Z", "");
}

/** A deterministic generator (Park-Miller), so the data looks irregular but never changes. */
function generator(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 48271) % 2147483647;
    return (state - 1) / 2147483646;
  };
}

interface Rack {
  name: string;
  hall: string;
  row: number;
  /** The rack's own share of power and heat. */
  basePowerW: number;
  inletOffset: number;
  cpuBase: number;
  /** Where the rack's slow drift starts, so the racks do not move in step. */
  phase: number;
}

function racks(random: () => number): Rack[] {
  const list: Rack[] = [];
  HALLS.forEach((hall, h) => {
    const code = hall.slice(-1);
    for (let row = 1; row <= ROWS; row++) {
      for (let k = 1; k <= RACKS_PER_ROW; k++) {
        list.push({
          name: `${code}${row}-${String(k).padStart(2, "0")}`,
          hall,
          row,
          // Hall B runs the dense compute racks, hall C mostly storage.
          basePowerW: (h === 1 ? 7200 : h === 2 ? 4300 : 5600) + random() * 3800,
          // The racks at the row ends sit next to the warm aisle return.
          inletOffset: (k === RACKS_PER_ROW ? 1.6 : 0) + (h === 1 ? 1.1 : 0) + random() * 1.4,
          cpuBase: 28 + random() * 22,
          phase: random() * 2 * Math.PI,
        });
      }
    }
  });
  return list;
}

/** Load over the day: low at night, a peak in the afternoon (Europe/Berlin, UTC+2). */
function dailyLoad(ms: number): number {
  const hour = (new Date(ms).getUTCHours() + 2 + new Date(ms).getUTCMinutes() / 60) % 24;
  return 0.62 + 0.3 * Math.max(0, Math.sin(((hour - 7) / 24) * 2 * Math.PI)) ** 1.3;
}

/**
 * Writes the metrics database: every five minutes over the last 24 hours, per rack its power
 * draw, inlet and outlet temperature and CPU load; per hall the IT and facility power (PUE) and
 * the network throughput.
 */
export function writeDatacenterDatabase(file: string, now = GALLERY_NOW): void {
  const random = generator(4711);
  const all = racks(random);
  const db = new DatabaseSync(file);
  try {
    db.exec(`
      CREATE TABLE rack_metrics (
        ts DATETIME NOT NULL,
        hall TEXT NOT NULL,
        row INTEGER NOT NULL,
        rack TEXT NOT NULL,
        power_w REAL NOT NULL,
        inlet_c REAL NOT NULL,
        outlet_c REAL NOT NULL,
        cpu_pct REAL NOT NULL
      );
      CREATE INDEX rack_metrics_ts ON rack_metrics (ts);
      CREATE TABLE hall_power (
        ts DATETIME NOT NULL,
        hall TEXT NOT NULL,
        it_w REAL NOT NULL,
        facility_w REAL NOT NULL
      );
      CREATE INDEX hall_power_ts ON hall_power (ts);
      CREATE TABLE network (
        ts DATETIME NOT NULL,
        hall TEXT NOT NULL,
        ingress_bps REAL NOT NULL,
        egress_bps REAL NOT NULL
      );
      CREATE INDEX network_ts ON network (ts);
    `);
    const rackRow = db.prepare(
      "INSERT INTO rack_metrics (ts, hall, row, rack, power_w, inlet_c, outlet_c, cpu_pct) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const hallRow = db.prepare(
      "INSERT INTO hall_power (ts, hall, it_w, facility_w) VALUES (?, ?, ?, ?)",
    );
    const netRow = db.prepare(
      "INSERT INTO network (ts, hall, ingress_bps, egress_bps) VALUES (?, ?, ?, ?)",
    );
    const step = STEP_MINUTES * 60 * 1000;
    const start = now - HOURS * 60 * 60 * 1000;
    db.exec("BEGIN");
    for (let t = start, n = 0; t <= now; t += step, n++) {
      const time = sqliteTime(t);
      const load = dailyLoad(t);
      const itPerHall = new Map<string, number>();
      for (const rack of all) {
        // A slow drift of its own and a little noise, as real sensors read.
        const drift = 0.6 * Math.sin(n / 9 + rack.phase) + 0.4 * Math.sin(n / 23 + 2 * rack.phase);
        const power = rack.basePowerW * (load + 0.025 * drift + (random() - 0.5) * 0.02);
        const inlet = 21.4 + rack.inletOffset + 2.2 * load + 0.3 * drift + (random() - 0.5) * 0.12;
        // One rack in hall B runs warm for a few hours before noon, then cools down again.
        const warm = rack.name === "B2-06" ? 2.6 * Math.exp(-(((n - 205) / 32) ** 4)) : 0;
        const cpu = Math.min(
          98,
          rack.cpuBase + 48 * (load - 0.6) * 1.6 + 3 * drift + (random() - 0.5) * 2,
        );
        rackRow.run(
          time,
          rack.hall,
          rack.row,
          rack.name,
          Math.round(power),
          Math.round((inlet + warm) * 10) / 10,
          Math.round((inlet + warm + 9.5 + 4 * load) * 10) / 10,
          Math.round(cpu * 10) / 10,
        );
        itPerHall.set(rack.hall, (itPerHall.get(rack.hall) ?? 0) + power);
      }
      HALLS.forEach((hall, h) => {
        const it = itPerHall.get(hall) ?? 0;
        // Cooling works harder in the warm afternoon; hall C has the newer chillers.
        const pue =
          1.24 +
          h * 0.035 -
          (h === 2 ? 0.09 : 0) +
          0.07 * load +
          0.004 * Math.sin(n / 11 + h) +
          (random() - 0.5) * 0.002;
        hallRow.run(time, hall, Math.round(it), Math.round(it * pue));
        const gbps = (h === 1 ? 92 : 58) * (0.45 + load) + 3 * Math.sin(n / 8 + h) + random() * 1.5;
        netRow.run(time, hall, Math.round(gbps * 1e9), Math.round(gbps * 0.72 * 1e9));
      });
    }
    db.exec("COMMIT");
  } finally {
    db.close();
  }
}

/** Log events of the switches and power gear, for the search source of the gallery. */
export function logEvents(now = GALLERY_NOW): Record<string, unknown>[] {
  const random = generator(1312);
  const devices = [
    ["leaf-a1-01", "network", "Hall A"],
    ["leaf-b2-02", "network", "Hall B"],
    ["spine-b1", "network", "Hall B"],
    ["core-1", "network", "Hall A"],
    ["pdu-b2-a", "power", "Hall B"],
    ["ups-c1", "power", "Hall C"],
    ["crah-b2", "cooling", "Hall B"],
    ["crah-a1", "cooling", "Hall A"],
  ] as const;
  const messages: Record<string, string[]> = {
    network: ["link flap on uplink", "BGP session re-established", "CRC errors on port 48"],
    power: ["branch circuit at 82 % of rating", "battery self-test passed", "input voltage dip"],
    cooling: ["supply air above setpoint", "fan speed raised to 78 %", "filter change due"],
  };
  const levels = ["info", "info", "info", "warning", "warning", "error"];
  const events: Record<string, unknown>[] = [];
  for (let i = 0; i < 240; i++) {
    const [host, kind, hall] = devices[Math.floor(random() * devices.length)] ?? devices[0];
    const list = messages[kind] ?? [];
    events.push({
      "@timestamp": now - Math.floor(random() * 24 * 60 * 60 * 1000),
      host,
      kind,
      hall,
      level: levels[Math.floor(random() * levels.length)] ?? "info",
      message: list[Math.floor(random() * list.length)] ?? "",
    });
  }
  return events;
}

/** Creates the index `kalzit-gallery-logs` on the OpenSearch at `base` and fills it. */
export async function seedLogs(base: string, index: string): Promise<void> {
  const call = async (method: string, path: string, body?: string, type?: string) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: body === undefined ? {} : { "content-type": type ?? "application/json" },
      ...(body === undefined ? {} : { body }),
    });
    if (!response.ok && !(method === "DELETE" && response.status === 404)) {
      throw new Error(`${method} ${path}: HTTP ${response.status} ${await response.text()}`);
    }
  };
  await call("DELETE", `/${index}`);
  await call(
    "PUT",
    `/${index}`,
    JSON.stringify({
      mappings: {
        properties: {
          "@timestamp": { type: "date" },
          host: { type: "keyword" },
          kind: { type: "keyword" },
          hall: { type: "keyword" },
          level: { type: "keyword" },
          message: { type: "text" },
        },
      },
    }),
  );
  const bulk = logEvents()
    .map((event) => `{"index":{}}\n${JSON.stringify(event)}\n`)
    .join("");
  await call("POST", `/${index}/_bulk?refresh=true`, bulk, "application/x-ndjson");
}
