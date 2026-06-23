import Database from "better-sqlite3";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || join(__dirname, "data.sqlite");

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

/**
 * Schema for a delivery agency platform.
 *
 *  users    -> admins / dispatchers and drivers (role column)
 *  drivers  -> extra info for users with role = 'driver' (vehicle, status, last location)
 *  orders   -> deliveries with pickup/dropoff, customer info and a status workflow
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT NOT NULL,
    email        TEXT NOT NULL UNIQUE,
    password     TEXT NOT NULL,
    role         TEXT NOT NULL CHECK (role IN ('admin', 'driver')),
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS drivers (
    user_id      INTEGER PRIMARY KEY,
    phone        TEXT,
    vehicle      TEXT,
    plate        TEXT,
    status       TEXT NOT NULL DEFAULT 'offline'
                 CHECK (status IN ('offline', 'available', 'busy')),
    lat          REAL,
    lng          REAL,
    speed        REAL,
    last_seen    TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS orders (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    code             TEXT NOT NULL UNIQUE,
    customer_name    TEXT NOT NULL,
    customer_phone   TEXT,
    pickup_address   TEXT NOT NULL,
    pickup_lat       REAL,
    pickup_lng       REAL,
    dropoff_address  TEXT NOT NULL,
    dropoff_lat      REAL,
    dropoff_lng      REAL,
    items            TEXT,
    notes            TEXT,
    amount           REAL DEFAULT 0,
    payment_method   TEXT DEFAULT 'cash',
    status           TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'assigned', 'picked_up', 'on_the_way', 'delivered', 'cancelled')),
    driver_id        INTEGER,
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    assigned_at      TEXT,
    delivered_at     TEXT,
    FOREIGN KEY (driver_id) REFERENCES users(id) ON DELETE SET NULL
  );

  CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
  CREATE INDEX IF NOT EXISTS idx_orders_driver ON orders(driver_id);

  CREATE TABLE IF NOT EXISTS location_history (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    driver_id  INTEGER,
    order_id   INTEGER,
    lat        REAL,
    lng        REAL,
    timestamp  TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (driver_id) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE SET NULL
  );

  CREATE INDEX IF NOT EXISTS idx_location_history_order ON location_history(order_id);
  CREATE INDEX IF NOT EXISTS idx_location_history_driver ON location_history(driver_id);
`);

// Add estimated columns to orders (ALTER TABLE doesn't support IF NOT EXISTS in SQLite)
try {
  db.exec("ALTER TABLE orders ADD COLUMN estimated_distance_km REAL");
} catch (_) { /* column already exists */ }

try {
  db.exec("ALTER TABLE orders ADD COLUMN estimated_minutes REAL");
} catch (_) { /* column already exists */ }

export default db;
