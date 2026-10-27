// The MongoDB data of the gallery renders (ui/e2e/gallery/gallery.shots.ts), run with mongosh as
// the container's root user by `.github/scripts/e2e-services.sh seed-gallery` in the gallery
// workflow only. A database of its own beside the e2e fixture, so the document spec's counts stay
// as they are. The fictional data center "Site Basalt": an asset inventory of servers (nested
// hardware, firmware and location) and the incidents of the last days. Names, vendors and
// figures are invented; everything is computed, so a rerun writes the same documents. The
// names and the password are those of GALLERY_MONGO in ui/e2e/gallery/datacenter.ts.
const target = db.getSiblingDB("kalzit_gallery");
target.dropAllUsers();
target.dropDatabase();

// A small deterministic generator, so the data looks irregular but never changes.
let seed = 20261020;
function random() {
  seed = (seed * 48271) % 2147483647;
  return (seed - 1) / 2147483646;
}
function pick(list) {
  return list[Math.floor(random() * list.length)];
}

const halls = ["A", "B", "C"];
const vendors = [
  { vendor: "Kestrel Systems", models: ["KX-2400", "KX-1200"], cpu: "Kestrel K9 64-core" },
  { vendor: "Orvane", models: ["SR-880", "SR-440"], cpu: "Orvane Helix 48-core" },
  { vendor: "Tessaline", models: ["T-Blade 7", "T-Store 12"], cpu: "Tessaline Q 32-core" },
];
const bios = ["2.18.1", "2.19.0", "2.19.0", "2.20.3", "2.20.3", "2.20.3"];
const bmc = ["4.10.4", "4.11.0", "4.12.2", "4.12.2", "4.12.2"];
const roles = ["compute", "compute", "compute", "database", "storage", "gpu"];
const statuses = ["in service", "in service", "in service", "in service", "maintenance", "staged"];
const now = Date.UTC(2026, 9, 20, 14, 0, 0);
const day = 24 * 60 * 60 * 1000;

const assets = [];
for (let i = 0; i < 144; i += 1) {
  const hall = halls[i % halls.length];
  const row = 1 + (Math.floor(i / 3) % 4);
  const rack = 1 + (Math.floor(i / 12) % 6);
  const unit = 4 + 6 * Math.floor(i / 72);
  const kind = vendors[(i + Math.floor(i / 7)) % vendors.length];
  const role = pick(roles);
  const sockets = role === "storage" ? 1 : 2;
  const disks = [];
  const diskCount = role === "storage" ? 12 : 2 + Math.floor(random() * 3);
  for (let d = 0; d < diskCount; d += 1) {
    disks.push(
      role === "storage"
        ? { slot: d, type: "hdd", sizeTb: 18 }
        : { slot: d, type: "nvme", sizeTb: pick([1.92, 3.84, 7.68]) },
    );
  }
  const asset = {
    assetTag: `SB-${String(10000 + i * 7)}`,
    hostname: `srv-${hall.toLowerCase()}${row}-${String(rack).padStart(2, "0")}-${unit}`,
    role,
    status: pick(statuses),
    vendor: kind.vendor,
    model: pick(kind.models),
    location: {
      site: "Site Basalt",
      hall: `Hall ${hall}`,
      row: `${hall}${row}`,
      rack: `${hall}${row}-${String(rack).padStart(2, "0")}`,
      unit,
    },
    hardware: {
      cpu: { model: kind.cpu, sockets },
      memoryGb: pick([256, 512, 512, 1024, 2048]),
      disks,
      nics: [
        { port: "eth0", speedGbps: 25 },
        { port: "eth1", speedGbps: 25 },
      ],
    },
    firmware: { bios: pick(bios), bmc: pick(bmc) },
    powerDrawW: Math.round(280 + random() * 620),
    commissionedAt: new Date(now - Math.floor(60 + random() * 1400) * day),
    warrantyUntil: new Date(now + Math.floor(-90 + random() * 1100) * day),
  };
  if (role === "gpu") {
    asset.hardware.gpus = [
      { model: "Kestrel A7 accelerator", memoryGb: 96 },
      { model: "Kestrel A7 accelerator", memoryGb: 96 },
    ];
  }
  if (asset.status === "maintenance") {
    asset.maintenance = {
      ticket: `CHG-${3100 + i}`,
      reason: pick(["fan replacement", "BMC update", "memory error", "disk swap"]),
    };
  }
  assets.push(asset);
}
target.assets.insertMany(assets);

const categories = [
  {
    category: "temperature",
    summary: "Inlet temperature above threshold",
    unit: "°C",
    threshold: 27,
  },
  { category: "power", summary: "PDU branch load above 80 %", unit: "%", threshold: 80 },
  { category: "network", summary: "Leaf uplink packet loss", unit: "%", threshold: 0.5 },
  { category: "hardware", summary: "Correctable memory errors", unit: "count", threshold: 100 },
  { category: "cooling", summary: "CRAH supply air drifting", unit: "°C", threshold: 24 },
];
const severities = ["warning", "warning", "minor", "minor", "major", "critical"];
const people = ["Lea Hoffmann", "Jonas Becker", "Tim Schulz", "night shift"];
const incidents = [];
for (let i = 0; i < 96; i += 1) {
  const kind = pick(categories);
  const asset = assets[Math.floor(random() * assets.length)];
  const openedAt = new Date(now - Math.floor(random() * 7 * day));
  const age = now - openedAt.getTime();
  const status =
    age < 3 * 3600000
      ? pick(["open", "acknowledged"])
      : pick(["resolved", "resolved", "resolved", "acknowledged"]);
  const value = Math.round(kind.threshold * (1.02 + random() * 0.25) * 100) / 100;
  const timeline = [
    { at: openedAt, by: "monitoring", note: `${kind.summary}: ${value} ${kind.unit}` },
  ];
  if (status !== "open") {
    timeline.push({
      at: new Date(openedAt.getTime() + 600000),
      by: pick(people),
      note: "acknowledged",
    });
  }
  if (status === "resolved") {
    timeline.push({
      at: new Date(openedAt.getTime() + 5400000),
      by: pick(people),
      note: "back below threshold",
    });
  }
  incidents.push({
    number: `INC-${4100 + i}`,
    openedAt,
    severity: pick(severities),
    category: kind.category,
    status,
    summary: kind.summary,
    source: { hall: asset.location.hall, rack: asset.location.rack, host: asset.hostname },
    measurement: { value, threshold: kind.threshold, unit: kind.unit },
    timeline,
  });
}
target.incidents.insertMany(incidents);

target.createUser({
  user: "kalzit_gallery_reader",
  pwd: "kalzit-gallery-reader",
  roles: [{ role: "read", db: "kalzit_gallery" }],
});
print(
  `kalzit_gallery: ${target.assets.countDocuments()} assets, ${target.incidents.countDocuments()} incidents`,
);
