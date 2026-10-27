-- The built-in sample database (datasources::sample): a small, made-up shop for trying Kalzit
-- without a database of one's own. Deterministic: every server builds the same rows. Orders run
-- from 2025-07-01 to 2026-06-30, about one every fourteen and a half hours.

BEGIN;

CREATE TABLE regions (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    country TEXT NOT NULL
);

INSERT INTO regions (id, name, country) VALUES
    (1, 'North', 'Germany'),
    (2, 'South', 'Germany'),
    (3, 'West', 'France'),
    (4, 'Alps', 'Austria'),
    (5, 'Lowlands', 'Netherlands'),
    (6, 'Nordic', 'Sweden');

CREATE TABLE products (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    unit_price REAL NOT NULL
);

INSERT INTO products (id, name, category, unit_price) VALUES
    (1, 'Basalt Desk Lamp', 'Lighting', 49.90),
    (2, 'Quartz Floor Lamp', 'Lighting', 129.00),
    (3, 'Granite Side Table', 'Furniture', 189.00),
    (4, 'Slate Bookshelf', 'Furniture', 249.00),
    (5, 'Marble Coaster Set', 'Kitchen', 19.50),
    (6, 'Flint Chef Knife', 'Kitchen', 79.00),
    (7, 'Jasper Mug', 'Kitchen', 12.90),
    (8, 'Onyx Wall Clock', 'Decor', 59.00),
    (9, 'Amber Candle', 'Decor', 14.90),
    (10, 'Opal Vase', 'Decor', 34.00),
    (11, 'Pumice Bath Towel', 'Textiles', 24.90),
    (12, 'Calcite Throw Blanket', 'Textiles', 69.00);

CREATE TABLE customers (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    segment TEXT NOT NULL,
    region_id INTEGER NOT NULL REFERENCES regions (id),
    created_at DATETIME NOT NULL
);

-- Forty names: eight adjectives times five nouns.
WITH RECURSIVE
    seq (i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM seq WHERE i < 40),
    adjectives (k, word) AS (
        VALUES (0, 'Blue'), (1, 'Bright'), (2, 'Clear'), (3, 'Golden'),
               (4, 'Green'), (5, 'Quiet'), (6, 'Silver'), (7, 'Swift')
    ),
    nouns (k, word) AS (
        VALUES (0, 'Bakery'), (1, 'Studio'), (2, 'Outfitters'), (3, 'Hotel'), (4, 'Workshop')
    )
INSERT INTO customers (id, name, segment, region_id, created_at)
SELECT
    i,
    (SELECT word FROM adjectives WHERE k = (i - 1) % 8) || ' ' || (SELECT word FROM nouns WHERE k = (i - 1) / 8),
    CASE i % 3 WHEN 0 THEN 'Business' WHEN 1 THEN 'Consumer' ELSE 'Public' END,
    (i * 5) % 6 + 1,
    datetime('2025-01-01', '+' || ((i * 7) % 180) || ' days')
FROM seq;

CREATE TABLE orders (
    id INTEGER PRIMARY KEY,
    ordered_at DATETIME NOT NULL,
    customer_id INTEGER NOT NULL REFERENCES customers (id),
    product_id INTEGER NOT NULL REFERENCES products (id),
    region_id INTEGER NOT NULL REFERENCES regions (id),
    quantity INTEGER NOT NULL,
    unit_price REAL NOT NULL,
    total REAL NOT NULL,
    status TEXT NOT NULL
);

-- 600 orders, 876 minutes apart with up to ten hours of jitter, so the year is covered evenly.
WITH RECURSIVE seq (i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM seq WHERE i < 600),
    picked AS (
        SELECT
            i,
            datetime('2025-07-01', '+' || ((i - 1) * 876 + (i * 7919) % 600) || ' minutes') AS ordered_at,
            (i * 17) % 40 + 1 AS customer_id,
            (i * 7 + i / 13) % 12 + 1 AS product_id,
            (i * 11) % 5 + 1 AS quantity
        FROM seq
    )
INSERT INTO orders (id, ordered_at, customer_id, product_id, region_id, quantity, unit_price, total, status)
SELECT
    p.i,
    p.ordered_at,
    p.customer_id,
    p.product_id,
    c.region_id,
    p.quantity,
    pr.unit_price,
    round(p.quantity * pr.unit_price, 2),
    CASE WHEN p.i % 23 = 0 THEN 'returned' WHEN p.i % 11 = 0 THEN 'cancelled' ELSE 'shipped' END
FROM picked p
JOIN customers c ON c.id = p.customer_id
JOIN products pr ON pr.id = p.product_id;

CREATE INDEX orders_ordered_at ON orders (ordered_at);

COMMIT;
