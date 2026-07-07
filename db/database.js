import initSqlJs from "sql.js";
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || join(__dirname, "data.sqlite");
const AUTO_SAVE_INTERVAL = parseInt(process.env.DB_SAVE_INTERVAL || "5000", 10);

// Ensure the database directory exists
const dbDir = dirname(DB_PATH);
if (!existsSync(dbDir)) {
  mkdirSync(dbDir, { recursive: true });
}

// Initialize sql.js using top-level await
const SQL = await initSqlJs();

// Load existing database or create new one
let rawDb;
if (existsSync(DB_PATH)) {
  try {
    const buffer = readFileSync(DB_PATH);
    rawDb = new SQL.Database(buffer);
  } catch (err) {
    console.error(`[DB] Error cargando base de datos desde ${DB_PATH}: ${err.message}`);
    console.error("[DB] Creando nueva base de datos...");
    rawDb = new SQL.Database();
  }
} else {
  rawDb = new SQL.Database();
}

/**
 * Wrapper that provides a better-sqlite3-compatible API on top of sql.js.
 * Includes immediate save after write operations for data safety,
 * with configurable periodic saves as a fallback.
 */
class DatabaseWrapper {
  constructor(sqlDb) {
    this._db = sqlDb;
    this._saveInterval = null;
    this._dirty = false;
    this._closed = false;
    this._saveCount = 0;
    this._errorCount = 0;
    this._lastSaveAt = null;

    // Periodic save as a safety net (catches any missed immediate saves)
    this._saveInterval = setInterval(() => {
      if (this._dirty) this._save();
    }, AUTO_SAVE_INTERVAL);
  }

  /**
   * Persist the database to disk.
   * @param {boolean} force - Save even if not marked dirty
   */
  _save(force = false) {
    if (this._closed && !force) return;
    if (!force && !this._dirty) return;

    try {
      const data = this._db.export();
      const buffer = Buffer.from(data);
      // Write to temp file, then rename for atomic writes (prevents corruption)
      const tmpPath = DB_PATH + ".tmp";
      writeFileSync(tmpPath, buffer, { flag: "w" });
      renameSync(tmpPath, DB_PATH);
      this._dirty = false;
      this._saveCount++;
      this._lastSaveAt = new Date().toISOString();
    } catch (err) {
      // Fallback: write directly if rename fails
      try {
        const data = this._db.export();
        const buffer = Buffer.from(data);
        writeFileSync(DB_PATH, buffer);
        this._dirty = false;
        this._saveCount++;
        this._lastSaveAt = new Date().toISOString();
      } catch (fallbackErr) {
        this._errorCount++;
        console.error(`[DB] Error guardando base de datos (intento #${this._errorCount}): ${fallbackErr.message}`);
      }
    }
  }

  /**
   * Save immediately after a write operation for data safety.
   * In production, every mutation is persisted right away.
   */
  _saveImmediate() {
    this._dirty = true;
    // Always save immediately to prevent data loss
    this._save();
  }

  _markDirty() {
    this._dirty = true;
  }

  /** Get database health/stats info */
  getStats() {
    return {
      saves: this._saveCount,
      errors: this._errorCount,
      dirty: this._dirty,
      lastSave: this._lastSaveAt,
      closed: this._closed,
    };
  }

  exec(sql) {
    if (this._closed) throw new Error("Database is closed");
    try {
      this._db.run(sql);
      this._saveImmediate();
    } catch (err) {
      console.error(`[DB] Error ejecutando SQL: ${err.message}`);
      throw err;
    }
  }

  pragma(pragmaStr) {
    try {
      this._db.run(`PRAGMA ${pragmaStr}`);
    } catch (_) {
      // Ignore pragma errors (WAL not supported in sql.js)
    }
  }

  prepare(sql) {
    if (this._closed) throw new Error("Database is closed");
    const self = this;

    return {
      run(...params) {
        if (self._closed) throw new Error("Database is closed");
        try {
          if (params.length === 1 && typeof params[0] === "object" && params[0] !== null && !Array.isArray(params[0])) {
            const obj = params[0];
            const bindObj = {};
            for (const [key, value] of Object.entries(obj)) {
              const prefixed = key.startsWith("@") || key.startsWith("$") || key.startsWith(":") ? key : `@${key}`;
              bindObj[prefixed] = value;
            }
            self._db.run(sql, bindObj);
          } else {
            self._db.run(sql, params);
          }
          // Save immediately after write operations
          self._saveImmediate();
          const lastId = self._db.exec("SELECT last_insert_rowid() as id")[0]?.values[0]?.[0] || 0;
          const changes = self._db.getRowsModified();
          return { lastInsertRowid: lastId, changes };
        } catch (err) {
          // Re-throw with context for better debugging
          const enhancedErr = new Error(`[DB] Error en run(): ${err.message}`);
          enhancedErr.originalError = err;
          enhancedErr.sql = sql;
          throw enhancedErr;
        }
      },

      get(...params) {
        if (self._closed) throw new Error("Database is closed");
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
        } catch (err) {
          const enhancedErr = new Error(`[DB] Error en get(): ${err.message}`);
          enhancedErr.originalError = err;
          enhancedErr.sql = sql;
          throw enhancedErr;
        } finally {
          if (stmt) stmt.free();
        }
      },

      all(...params) {
        if (self._closed) throw new Error("Database is closed");
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
        } catch (err) {
          const enhancedErr = new Error(`[DB] Error en all(): ${err.message}`);
          enhancedErr.originalError = err;
          enhancedErr.sql = sql;
          throw enhancedErr;
        } finally {
          if (stmt) stmt.free();
        }
      },
    };
  }

  transaction(fn) {
    return (...args) => {
      if (this._closed) throw new Error("Database is closed");
      this._db.run("BEGIN TRANSACTION");
      try {
        const result = fn(...args);
        this._db.run("COMMIT");
        // Save immediately after a successful transaction
        this._saveImmediate();
        return result;
      } catch (e) {
        this._db.run("ROLLBACK");
        throw e;
      }
    };
  }

  close() {
    if (this._closed) return;
    this._closed = true;
    if (this._saveInterval) {
      clearInterval(this._saveInterval);
      this._saveInterval = null;
    }
    // Final save before closing
    this._dirty = true;
    this._save(true);
    try {
      this._db.close();
    } catch (err) {
      console.error(`[DB] Error cerrando base de datos: ${err.message}`);
    }
  }
}

const db = new DatabaseWrapper(rawDb);

// ─── Schema Creation ─────────────────────────────────────────────────────────

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
    estimated_distance_km REAL,
    estimated_minutes REAL,
    status           TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'assigned', 'picked_up', 'on_the_way', 'delivered', 'cancelled')),
    driver_id        INTEGER,
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    assigned_at      TEXT,
    delivered_at     TEXT,
    FOREIGN KEY (driver_id) REFERENCES users(id) ON DELETE SET NULL
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

// ─── Indexes ─────────────────────────────────────────────────────────────────

try { db.exec("CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status)"); } catch (_) {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_orders_driver ON orders(driver_id)"); } catch (_) {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at)"); } catch (_) {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_location_history_order ON location_history(order_id)"); } catch (_) {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_location_history_driver ON location_history(driver_id)"); } catch (_) {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_location_history_timestamp ON location_history(timestamp)"); } catch (_) {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)"); } catch (_) {}

// Save initial schema to disk
db._save(true);

export default db;
