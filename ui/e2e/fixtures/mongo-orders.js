// The MongoDB fixture of the document spec (ui/e2e/documents.spec.ts), run with mongosh as the
// container's root user (.github/scripts/e2e-services.sh). Orders as a shop keeps them: a status,
// a nested customer and an array of items. Kalzit reads with a login that may only read, as it
// requires; the names, the password and the counts are those of ui/e2e/support/services.ts.
const target = db.getSiblingDB("kalzit_e2e");
target.dropAllUsers();
target.dropDatabase();
const statuses = ["paid", "shipped", "paid", "open"];
const regions = [
  ["Nord", "Hamburg"],
  ["Süd", "München"],
  ["West", "Köln"],
  ["Ost", "Leipzig"],
  ["Nord", "Bremen"],
];
const products = [
  ["Desk lamp", 39.9],
  ["Office chair", 249],
  ["Monitor arm", 89],
  ["Keyboard", 79],
];
const start = Date.UTC(2026, 9, 20, 8, 0, 0);
const orders = [];
for (let i = 0; i < 48; i += 1) {
  const [region, city] = regions[i % regions.length];
  const [name, price] = products[(i * 7) % products.length];
  const quantity = (i % 3) + 1;
  orders.push({
    number: `A-${1000 + i}`,
    status: statuses[i % statuses.length],
    createdAt: new Date(start + i * 600000),
    customer: { region, city },
    items: [{ name, quantity, price }],
    total: Math.round(quantity * price * 100) / 100,
  });
}
target.orders.insertMany(orders);
target.createUser({
  user: "kalzit_reader",
  pwd: "kalzit-e2e-reader",
  roles: [{ role: "read", db: "kalzit_e2e" }],
});
print(`kalzit_e2e.orders: ${target.orders.countDocuments()} documents`);
