import { readFileSync, writeFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const DATABASE_URL = process.env.DATABASE_URL;
export const isPostgres = !!DATABASE_URL;

/**
 * Unified async database layer.
 *
 * - If DATABASE_URL is set  -> PostgreSQL (via `pg`)  [production / Render]
 * - Otherwise               -> sql.js SQLite file     [local development]
 *
 * Public async API (used by the rest of the app):
 *   await db.get(sql, params)  -> first row object (or undefined)
 *   await db.all(sql, params)  -> array of row objects
 *   await db.run(sql, params)  -> { lastInsertRowid, changes }
 *   await db.exec(sql)         -> run raw SQL (no params)
 *   await db.end()             -> close connections (used by seed)
 *   db.isPostgres              -> boolean
 *
 * SQL is written in SQLite-ish style using `?` placeholders and
 * `datetime('now')`. For PostgreSQL these are translated automatically.
 */

// Tables that have an auto-increment `id` column (need RETURNING id on pg).
const ID_TABLES = new Set(["users", "orders", "location_history", "messages"]);

function insertTable(sql) {
  const m = /^\s*insert\s+into\s+["`\[]?(\w+)/i.exec(sql);
  return m ? m[1] : null;
}

let impl;

if (isPostgres) {
  // ─── PostgreSQL backend ────────────────────────────────────────────────────
  const pg = await import("pg");
  const { Pool } = pg.default;

  const needSsl = /render\.com/.test(DATABASE_URL) || process.env.PGSSL === "true";
  const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: needSsl ? { rejectUnauthorized: false } : false,
  });

  function translate(sql) {
    // datetime('now') -> NOW()
    let s = sql.replace(/datetime\('now'\)/gi, "NOW()");
    // ? -> $1, $2, ...
    let i = 0;
    s = s.replace(/\?/g, () => `$${++i}`);
    return s;
  }

  impl = {
    isPostgres: true,
    async run(sql, params = []) {
      let s = translate(sql);
      const isInsert = /^\s*insert/i.test(sql);
      const table = insertTable(sql);
      if (isInsert && table && ID_TABLES.has(table) && !/returning/i.test(s)) {
        s += " RETURNING id";
      }
      const result = await pool.query(s, params);
      let lastInsertRowid = null;
      if (isInsert && result.rows && result.rows[0] && "id" in result.rows[0]) {
        lastInsertRowid = result.rows[0].id;
      }
      return { lastInsertRowid, changes: result.rowCount };
    },
    async get(sql, params = []) {
      const result = await pool.query(translate(sql), params);
      return result.rows[0];
    },
    async all(sql, params = []) {
      const result = await pool.query(translate(sql), params);
      return result.rows;
    },
    async exec(sql) {
      await pool.query(sql);
    },
    async end() {
      await pool.end();
    },
  };
} else {
  // ─── sql.js (SQLite) backend ─────────────────────────────────────────────────
  const initSqlJs = (await import("sql.js")).default;
  const SQL = await initSqlJs();

  const DB_PATH = process.env.DB_PATH || join(__dirname, "data.sqlite");
  const raw = existsSync(DB_PATH) ? new SQL.Database(readFileSync(DB_PATH)) : new SQL.Database();

  let dirty = false;
  let closed = false;
  const save = () => {
    if (closed) return;
    try {
      writeFileSync(DB_PATH, Buffer.from(raw.export()));
      dirty = false;
    } catch (e) {
      console.error("Error saving database:", e.message);
    }
  };
  const interval = setInterval(() => {
    if (dirty) save();
  }, 3000);

  impl = {
    isPostgres: false,
    async run(sql, params = []) {
      raw.run(sql, params.length ? params : undefined);
      dirty = true;
      const idRes = raw.exec("SELECT last_insert_rowid() AS id");
      const lastInsertRowid = idRes[0]?.values[0]?.[0] ?? null;
      return { lastInsertRowid, changes: raw.getRowsModified() };
    },
    async get(sql, params = []) {
      const stmt = raw.prepare(sql);
      try {
        if (params.length) stmt.bind(params);
        if (stmt.step()) return stmt.getAsObject();
        return undefined;
      } finally {
        stmt.free();
      }
    },
    async all(sql, params = []) {
      const stmt = raw.prepare(sql);
      try {
        if (params.length) stmt.bind(params);
        const rows = [];
        while (stmt.step()) rows.push(stmt.getAsObject());
        return rows;
      } finally {
        stmt.free();
      }
    },
    async exec(sql) {
      raw.run(sql);
      dirty = true;
    },
    async end() {
      clearInterval(interval);
      save();
      closed = true;
      raw.close();
    },
    _save: save,
  };

  process.on("exit", save);
  process.on("SIGINT", () => { save(); process.exit(0); });
  process.on("SIGTERM", () => { save(); process.exit(0); });
}

/** Create tables and indexes. Call once at startup. */
export async function init() {
  if (isPostgres) {
    await impl.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id          SERIAL PRIMARY KEY,
        name        TEXT NOT NULL,
        email       TEXT NOT NULL UNIQUE,
        password    TEXT NOT NULL,
        role        TEXT NOT NULL CHECK (role IN ('admin','driver')),
        created_at  TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS drivers (
        user_id   INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        phone     TEXT,
        vehicle   TEXT,
        plate     TEXT,
        status    TEXT NOT NULL DEFAULT 'offline' CHECK (status IN ('offline','available','busy')),
        lat       DOUBLE PRECISION,
        lng       DOUBLE PRECISION,
        speed     DOUBLE PRECISION,
        last_seen TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS orders (
        id                    SERIAL PRIMARY KEY,
        code                  TEXT NOT NULL UNIQUE,
        customer_name         TEXT NOT NULL,
        customer_phone        TEXT,
        pickup_address        TEXT NOT NULL,
        pickup_lat            DOUBLE PRECISION,
        pickup_lng            DOUBLE PRECISION,
        dropoff_address       TEXT NOT NULL,
        dropoff_lat           DOUBLE PRECISION,
        dropoff_lng           DOUBLE PRECISION,
        items                 TEXT,
        notes                 TEXT,
        amount                DOUBLE PRECISION DEFAULT 0,
        payment_method        TEXT DEFAULT 'cash',
        estimated_distance_km DOUBLE PRECISION,
        estimated_minutes     DOUBLE PRECISION,
        status                TEXT NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending','assigned','picked_up','on_the_way','delivered','cancelled')),
        driver_id             INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at            TIMESTAMP NOT NULL DEFAULT NOW(),
        assigned_at           TIMESTAMP,
        delivered_at          TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS location_history (
        id         SERIAL PRIMARY KEY,
        driver_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
        order_id   INTEGER REFERENCES orders(id) ON DELETE SET NULL,
        lat        DOUBLE PRECISION,
        lng        DOUBLE PRECISION,
        timestamp  TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
      CREATE INDEX IF NOT EXISTS idx_orders_driver ON orders(driver_id);
      CREATE INDEX IF NOT EXISTS idx_lh_order ON location_history(order_id);
      CREATE INDEX IF NOT EXISTS idx_lh_driver ON location_history(driver_id);

      CREATE TABLE IF NOT EXISTS messages (
        id          SERIAL PRIMARY KEY,
        driver_id   INTEGER NOT NULL,
        sender_id   INTEGER NOT NULL,
        sender_role TEXT NOT NULL,
        body        TEXT NOT NULL,
        created_at  TIMESTAMP NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_messages_driver ON messages(driver_id);

      CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY,
        value TEXT
      );

      CREATE TABLE IF NOT EXISTS order_proofs (
        order_id   INTEGER PRIMARY KEY,
        image      TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS activity_log (
        id         SERIAL PRIMARY KEY,
        user_id    INTEGER,
        user_name  TEXT,
        role       TEXT,
        action     TEXT NOT NULL,
        detail     TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_log(created_at);
    `);
    // rating column (safe add for existing tables)
    try { await impl.exec("ALTER TABLE orders ADD COLUMN IF NOT EXISTS rating INTEGER"); } catch (_) {}
    try { await impl.exec("ALTER TABLE orders ADD COLUMN IF NOT EXISTS review TEXT"); } catch (_) {}
    try { await impl.exec("ALTER TABLE orders ADD COLUMN IF NOT EXISTS picked_up_at TIMESTAMP"); } catch (_) {}
    try { await impl.exec("ALTER TABLE orders ADD COLUMN IF NOT EXISTS on_the_way_at TIMESTAMP"); } catch (_) {}
  } else {
    await impl.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT NOT NULL,
        email       TEXT NOT NULL UNIQUE,
        password    TEXT NOT NULL,
        role        TEXT NOT NULL CHECK (role IN ('admin','driver')),
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS drivers (
        user_id   INTEGER PRIMARY KEY,
        phone     TEXT,
        vehicle   TEXT,
        plate     TEXT,
        status    TEXT NOT NULL DEFAULT 'offline' CHECK (status IN ('offline','available','busy')),
        lat       REAL,
        lng       REAL,
        speed     REAL,
        last_seen TEXT,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS orders (
        id                    INTEGER PRIMARY KEY AUTOINCREMENT,
        code                  TEXT NOT NULL UNIQUE,
        customer_name         TEXT NOT NULL,
        customer_phone        TEXT,
        pickup_address        TEXT NOT NULL,
        pickup_lat            REAL,
        pickup_lng            REAL,
        dropoff_address       TEXT NOT NULL,
        dropoff_lat           REAL,
        dropoff_lng           REAL,
        items                 TEXT,
        notes                 TEXT,
        amount                REAL DEFAULT 0,
        payment_method        TEXT DEFAULT 'cash',
        estimated_distance_km REAL,
        estimated_minutes     REAL,
        status                TEXT NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending','assigned','picked_up','on_the_way','delivered','cancelled')),
        driver_id             INTEGER,
        created_at            TEXT NOT NULL DEFAULT (datetime('now')),
        assigned_at           TEXT,
        delivered_at          TEXT,
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

      CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
      CREATE INDEX IF NOT EXISTS idx_orders_driver ON orders(driver_id);
      CREATE INDEX IF NOT EXISTS idx_lh_order ON location_history(order_id);
      CREATE INDEX IF NOT EXISTS idx_lh_driver ON location_history(driver_id);

      CREATE TABLE IF NOT EXISTS messages (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        driver_id   INTEGER NOT NULL,
        sender_id   INTEGER NOT NULL,
        sender_role TEXT NOT NULL,
        body        TEXT NOT NULL,
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_messages_driver ON messages(driver_id);

      CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY,
        value TEXT
      );

      CREATE TABLE IF NOT EXISTS order_proofs (
        order_id   INTEGER PRIMARY KEY,
        image      TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS activity_log (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    INTEGER,
        user_name  TEXT,
        role       TEXT,
        action     TEXT NOT NULL,
        detail     TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_log(created_at);
    `);
    // rating column (safe add for existing sqlite tables)
    try { await impl.exec("ALTER TABLE orders ADD COLUMN rating INTEGER"); } catch (_) {}
    try { await impl.exec("ALTER TABLE orders ADD COLUMN review TEXT"); } catch (_) {}
    try { await impl.exec("ALTER TABLE orders ADD COLUMN picked_up_at TEXT"); } catch (_) {}
    try { await impl.exec("ALTER TABLE orders ADD COLUMN on_the_way_at TEXT"); } catch (_) {}
    impl._save();
  }
}

/** SQL fragment for an integer COUNT(*) (pg returns bigint as string otherwise). */
export const COUNT_INT = isPostgres ? "COUNT(*)::int" : "COUNT(*)";

export default impl;
