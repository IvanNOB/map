/**
 * Ghosty — Client Memory
 *
 * Remembers frequent customers: names, phones, addresses, and order preferences.
 * Used by Ghosty Brain to auto-fill orders and personalize conversations.
 */

import { Router } from "express";
import db from "../../db/database.js";
import { requireAuth, requireRole } from "../auth.js";

const router = Router();

// ─── Initialize table ─────────────────────────────────────────────────────────

export async function initClientMemory() {
  if (db.isPostgres) {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS client_memory (
        id              SERIAL PRIMARY KEY,
        phone           TEXT NOT NULL,
        name            TEXT NOT NULL,
        default_address TEXT,
        default_lat     DOUBLE PRECISION,
        default_lng     DOUBLE PRECISION,
        notes           TEXT,
        total_orders    INTEGER NOT NULL DEFAULT 0,
        last_order_at   TIMESTAMP,
        created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMP NOT NULL DEFAULT NOW()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_client_memory_phone ON client_memory(phone);
      CREATE INDEX IF NOT EXISTS idx_client_memory_name ON client_memory(name);
    `);
  } else {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS client_memory (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        phone           TEXT NOT NULL UNIQUE,
        name            TEXT NOT NULL,
        default_address TEXT,
        default_lat     REAL,
        default_lng     REAL,
        notes           TEXT,
        total_orders    INTEGER NOT NULL DEFAULT 0,
        last_order_at   TEXT,
        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_client_memory_name ON client_memory(name);
    `);
  }

  // Addresses sub-table (a client can have multiple saved addresses)
  if (db.isPostgres) {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS client_addresses (
        id         SERIAL PRIMARY KEY,
        client_id  INTEGER NOT NULL REFERENCES client_memory(id) ON DELETE CASCADE,
        label      TEXT NOT NULL DEFAULT 'Casa',
        address    TEXT NOT NULL,
        lat        DOUBLE PRECISION,
        lng        DOUBLE PRECISION,
        use_count  INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_client_addr_client ON client_addresses(client_id);
    `);
  } else {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS client_addresses (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        client_id  INTEGER NOT NULL,
        label      TEXT NOT NULL DEFAULT 'Casa',
        address    TEXT NOT NULL,
        lat        REAL,
        lng        REAL,
        use_count  INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (client_id) REFERENCES client_memory(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_client_addr_client ON client_addresses(client_id);
    `);
  }
}

// ─── Core functions (used by Ghosty Brain) ────────────────────────────────────

/**
 * Find or create a client by phone number.
 * Returns the client record with their saved addresses.
 */
export async function findOrCreateClient(phone, name = "") {
  const cleanPhone = normalizePhone(phone);
  if (!cleanPhone) return null;

  let client = await db.get(
    "SELECT * FROM client_memory WHERE phone = ?",
    [cleanPhone]
  );

  if (!client && name) {
    await db.run(
      "INSERT INTO client_memory (phone, name) VALUES (?, ?)",
      [cleanPhone, name.trim()]
    );
    client = await db.get("SELECT * FROM client_memory WHERE phone = ?", [cleanPhone]);
  }

  if (client) {
    client.addresses = await db.all(
      "SELECT * FROM client_addresses WHERE client_id = ? ORDER BY use_count DESC",
      [client.id]
    );
  }

  return client || null;
}

/**
 * Update client info after a successful order.
 */
export async function recordOrder(phone, { name, address, lat, lng }) {
  const cleanPhone = normalizePhone(phone);
  if (!cleanPhone) return;

  let client = await db.get("SELECT * FROM client_memory WHERE phone = ?", [cleanPhone]);

  if (!client) {
    await db.run(
      "INSERT INTO client_memory (phone, name, default_address, default_lat, default_lng, total_orders, last_order_at) VALUES (?, ?, ?, ?, ?, 1, datetime('now'))",
      [cleanPhone, name || "Cliente", address || null, lat || null, lng || null]
    );
    client = await db.get("SELECT * FROM client_memory WHERE phone = ?", [cleanPhone]);
  } else {
    const updateName = name && name.trim() ? name.trim() : client.name;
    await db.run(
      "UPDATE client_memory SET name = ?, total_orders = total_orders + 1, last_order_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
      [updateName, client.id]
    );
  }

  // Save/update address
  if (client && address) {
    const existingAddr = await db.get(
      "SELECT id FROM client_addresses WHERE client_id = ? AND address = ?",
      [client.id, address]
    );
    if (existingAddr) {
      await db.run(
        "UPDATE client_addresses SET use_count = use_count + 1, lat = COALESCE(?, lat), lng = COALESCE(?, lng) WHERE id = ?",
        [lat || null, lng || null, existingAddr.id]
      );
    } else {
      await db.run(
        "INSERT INTO client_addresses (client_id, label, address, lat, lng) VALUES (?, ?, ?, ?, ?)",
        [client.id, "Entrega", address, lat || null, lng || null]
      );
    }
  }
}

/**
 * Get client context for Ghosty Brain (summary for the AI prompt).
 */
export async function getClientContext(phone) {
  const client = await findOrCreateClient(phone);
  if (!client) return null;

  return {
    id: client.id,
    name: client.name,
    phone: client.phone,
    total_orders: client.total_orders,
    default_address: client.default_address,
    addresses: (client.addresses || []).map((a) => ({
      label: a.label,
      address: a.address,
      use_count: a.use_count,
    })),
    is_frequent: client.total_orders >= 3,
  };
}

// ─── Phone normalization ──────────────────────────────────────────────────────

function normalizePhone(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/[^\d+]/g, "");
  if (digits.length < 7) return null;
  // Ensure Colombian format (+57) if no country code
  if (digits.startsWith("+")) return digits;
  if (digits.startsWith("57") && digits.length >= 12) return "+" + digits;
  if (digits.length === 10) return "+57" + digits;
  return "+" + digits;
}

// ─── Admin API ────────────────────────────────────────────────────────────────

// GET /api/ghosty/clients - list all remembered clients
router.get("/", requireAuth, requireRole("admin"), async (req, res) => {
  const clients = await db.all(
    "SELECT id, phone, name, default_address, total_orders, last_order_at FROM client_memory ORDER BY last_order_at DESC LIMIT 200"
  );
  res.json(clients);
});

// GET /api/ghosty/clients/:phone - get client by phone
router.get("/:phone", requireAuth, requireRole("admin"), async (req, res) => {
  const client = await findOrCreateClient(req.params.phone);
  if (!client) return res.status(404).json({ error: "Cliente no encontrado" });
  res.json(client);
});

// DELETE /api/ghosty/clients/:id - forget a client
router.delete("/:id", requireAuth, requireRole("admin"), async (req, res) => {
  await db.run("DELETE FROM client_memory WHERE id = ?", [req.params.id]);
  res.json({ ok: true });
});

export default router;
