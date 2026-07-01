import initSqlJs from "sql.js";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || join(__dirname, "data.sqlite");

// Initialize sql.js synchronously-ish using top-level await
const SQL = await initSqlJs();

// Load existing database or create new one
let rawDb;
if (existsSync(DB_PATH)) {
  const buffer = readFileSync(DB_PATH);
  rawDb = new SQL.Database(buffer);
} else {
  rawDb = new SQL.Database();
}

/**
 * Wrapper that provides a better-sqlite3-compatible API on top of sql.js.
 * This allows the rest of the codebase to work without changes.
 */
class DatabaseWrapper {
  constructor(sqlDb) {
    this._db = sqlDb;
    this._saveInterval = null;
    this._dirty = false;

    // Auto-save every 5 seconds if dirty
    this._saveInterval = setInterval(() => {
      if (this._dirty) this._save();
    }, 5000);
  }

  _save() {
    try {
      const data = this._db.export();
      const buffer = Buffer.from(data);
      writeFileSync(DB_PATH, buffer);
      this._dirty = false;
    } catch (e) {
      console.error("Error saving database:", e.message);
    }
  }

  _markDirty() {
    this._dirty = true;
  }

  exec(sql) {
    this._db.run(sql);
    this._markDirty();
  }

  pragma(pragmaStr) {
    try {
      this._db.run(`PRAGMA ${pragmaStr}`);
    } catch (_) {
      // Ignore pragma errors (WAL not supported in sql.js)
    }
  }

  prepare(sql) {
    const self = this;
    return {
      run(...params) {
        // Handle named parameters (objects like { @name: value })
        if (params.length === 1 && typeof params[0] === "object" && params[0] !== null && !Array.isArray(params[0])) {
          const obj = params[0];
          // Convert @key or $key or :key notation
          const bindObj = {};
          for (const [key, value] of Object.entries(obj)) {
            // sql.js expects $key, :key, or @key
            const prefixed = key.startsWith("@") || key.startsWith("$") || key.startsWith(":") ? key : `@${key}`;
            bindObj[prefixed] = value;
          }
          self._db.run(sql, bindObj);
        } else {
          self._db.run(sql, params);
        }
        self._markDirty();
        const lastId = self._db.exec("SELECT last_insert_rowid() as id")[0]?.values[0]?.[0] || 0;
        const changes = self._db.getRowsModified();
        return { lastInsertRowid: lastId, changes };
      },

      get(...params) {
        let stmt;
        try {
          stmt = self._db.prepare(sql);
          if (params.length === 1 && typeof params[0] === "object" && params[0] !== null && !Array.isArray(params[0])) {
            const obj = params[0];
            const bindObj = {};
            for (const [key, value] of Object.entries(obj)) {
              const prefixed = key.startsWith("@") || key.startsWith("$") || key.startsWith(":") ? key : `@${key}`;
              bindObj[prefixed] = value;
            }
            stmt.bind(bindObj);
          } else if (params.length > 0) {
            stmt.bind(params);
          }
          if (stmt.step()) {
            const columns = stmt.getColumnNames();
            const values = stmt.get();
            const row = {};
            for (let i = 0; i < columns.length; i++) {
              row[columns[i]] = values[i];
            }
            return row;
          }
          return undefined;
        } finally {
          if (stmt) stmt.free();
        }
      },

      all(...params) {
        let stmt;
        try {
          stmt = self._db.prepare(sql);
          if (params.length === 1 && typeof params[0] === "object" && params[0] !== null && !Array.isArray(params[0])) {
            const obj = params[0];
            const bindObj = {};
            for (const [key, value] of Object.entries(obj)) {
              const prefixed = key.startsWith("@") || key.startsWith("$") || key.startsWith(":") ? key : `@${key}`;
              bindObj[prefixed] = value;
            }
            stmt.bind(bindObj);
          } else if (params.length > 0) {
            stmt.bind(params);
          }
          const rows = [];
          while (stmt.step()) {
            const columns = stmt.getColumnNames();
            const values = stmt.get();
            const row = {};
            for (let i = 0; i < columns.length; i++) {
              row[columns[i]] = values[i];
            }
            rows.push(row);
          }
          return rows;
        } finally {
          if (stmt) stmt.free();
        }
      },
    };
  }

  transaction(fn) {
    return (...args) => {
      this._db.run("BEGIN TRANSACTION");
      try {
        const result = fn(...args);
        this._db.run("COMMIT");
        this._markDirty();
        return result;
      } catch (e) {
        this._db.run("ROLLBACK");
        throw e;
      }
    };
  }

  close() {
    if (this._saveInterval) clearInterval(this._saveInterval);
    this._save();
    this._db.close();
  }
}

const db = new DatabaseWrapper(rawDb);

// Run schema creation
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT NOT NULL,
    email        TEXT NOT NULL UNIQUE,
    password     TEXT NOT NULL,
    role         TEXT NOT NULL CHECK (role IN ('admin', 'driver', 'restaurant')),
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
    estimated_distance_km REAL,
    estimated_minutes REAL,
    status           TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'confirmed', 'preparing', 'ready_for_pickup', 'assigned', 'picked_up', 'on_the_way', 'delivered', 'cancelled')),
    driver_id        INTEGER,
    restaurant_id    INTEGER,
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    confirmed_at     TEXT,
    ready_at         TEXT,
    assigned_at      TEXT,
    delivered_at     TEXT,
    FOREIGN KEY (driver_id) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY (restaurant_id) REFERENCES users(id) ON DELETE SET NULL
  );

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
`);

// Restaurants table
db.exec(`
  CREATE TABLE IF NOT EXISTS restaurants (
    user_id      INTEGER PRIMARY KEY,
    phone        TEXT,
    address      TEXT,
    lat          REAL,
    lng          REAL,
    category     TEXT DEFAULT 'general',
    description  TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
`);

// Create indexes (ignore errors if they exist)
try { db.exec("CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status)"); } catch (_) {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_orders_driver ON orders(driver_id)"); } catch (_) {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_location_history_order ON location_history(order_id)"); } catch (_) {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_location_history_driver ON location_history(driver_id)"); } catch (_) {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_orders_restaurant ON orders(restaurant_id)"); } catch (_) {}

// Save initial schema to disk
db._save();

// Graceful shutdown
process.on("exit", () => db._save());
process.on("SIGINT", () => { db.close(); process.exit(0); });
process.on("SIGTERM", () => { db.close(); process.exit(0); });

export default db;
