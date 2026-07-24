/**
 * Ghosty — Auto-Dispatcher (Suggestion Mode)
 *
 * When Ghosty Brain creates an order from WhatsApp:
 * 1. Creates the order in the database.
 * 2. Finds the nearest available driver(s).
 * 3. Sends a suggestion to admin via Socket.IO.
 * 4. Waits for admin confirmation before assigning.
 *
 * The admin sees a notification: "Ghosty sugiere asignar pedido ORD-XXXX a [Repartidor]"
 * with buttons to confirm or reject.
 */

import { Router } from "express";
import db from "../../db/database.js";
import config from "../config/index.js";
import logger from "../config/logger.js";
import { requireAuth, requireRole } from "../auth.js";
import { sendTextMessage } from "./whatsapp-cloud.js";

const router = Router();

let _io = null;

/**
 * Initialize the dispatcher with the Socket.IO instance.
 * Called once from server.js after io is created.
 */
export function initDispatcher(io) {
  _io = io;

  // Register the global callback for Ghosty orders from WhatsApp
  globalThis._ghostyOrderCallback = async (orderData) => {
    try {
      await handleGhostyOrder(orderData);
    } catch (error) {
      logger.error("Ghosty dispatcher error", { error: error?.message });
    }
  };

  logger.info("Ghosty Auto-Dispatcher initialized");
}

// ─── Create order and suggest driver ──────────────────────────────────────────

async function handleGhostyOrder(orderData) {
  // 1. Create the order in the database
  const order = await createOrderFromGhosty(orderData);
  if (!order) {
    logger.warn("Ghosty dispatcher: failed to create order", { orderData });
    return;
  }

  // 2. Find nearest available drivers
  const suggestions = await findNearestDrivers(order);

  // 3. Emit to admin panel via Socket.IO
  if (_io) {
    _io.to("admins").emit("order:new", order);
    _io.to("admins").emit("ghosty:suggest", {
      order_id: order.id,
      order_code: order.code,
      customer_name: order.customer_name,
      pickup_address: order.pickup_address,
      dropoff_address: order.dropoff_address,
      items: order.items,
      suggestions: suggestions.map((s) => ({
        driver_id: s.id,
        driver_name: s.name,
        distance_km: s.distance_km,
        vehicle: s.vehicle,
        deliveries_today: s.deliveries_today || 0,
      })),
      created_at: new Date().toISOString(),
    });
  }

  logger.info("Ghosty order created with suggestions", {
    code: order.code,
    suggestions: suggestions.length,
    best: suggestions[0]?.name || "none",
  });
}

// ─── Create order (replicates core logic from orders.js) ──────────────────────

function generateCode() {
  const ts = Date.now().toString(36).toUpperCase().slice(-4);
  return `GH-${ts}${Math.random().toString(36).slice(2, 4).toUpperCase()}`;
}

function getDeliveryFare() {
  const hour = new Date().getHours();
  return hour >= config.fareNightStartHour ? config.fareNight : config.fareDay;
}

async function createOrderFromGhosty(data) {
  const MAX_RETRIES = 5;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const code = generateCode();
    try {
      const info = await db.run(
        `INSERT INTO orders (code, customer_name, customer_phone, pickup_address, dropoff_address, items, notes, amount, payment_method)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          code,
          data.customer_name || "Cliente WhatsApp",
          data.customer_phone || null,
          data.pickup_address || "",
          data.dropoff_address || "",
          data.items || null,
          data.notes || "Pedido creado por Ghosty via WhatsApp",
          getDeliveryFare(),
          "cash",
        ]
      );
      const order = await db.get("SELECT * FROM orders WHERE id = ?", [info.lastInsertRowid]);
      return order;
    } catch (err) {
      const isUnique =
        err.code === "23505" ||
        (err.message && (err.message.includes("UNIQUE") || err.message.toLowerCase().includes("duplicate")));
      if (isUnique && attempt < MAX_RETRIES - 1) continue;
      logger.error("Ghosty create order DB error", { error: err?.message });
      return null;
    }
  }
  return null;
}

// ─── Find nearest drivers ─────────────────────────────────────────────────────

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

async function findNearestDrivers(order) {
  // Get all available drivers with location
  const drivers = await db.all(`
    SELECT u.id, u.name, d.lat, d.lng, d.vehicle, d.speed, d.status
    FROM users u
    JOIN drivers d ON d.user_id = u.id
    WHERE d.status = 'available' AND d.lat IS NOT NULL AND d.lng IS NOT NULL
  `);

  if (!order.pickup_lat || !order.pickup_lng) {
    // No coordinates on order — return all available drivers without distance
    return drivers.slice(0, 3).map((d) => ({
      ...d,
      distance_km: null,
    }));
  }

  // Calculate distance and sort
  const withDistance = drivers.map((d) => ({
    ...d,
    distance_km: Math.round(haversineKm(order.pickup_lat, order.pickup_lng, d.lat, d.lng) * 10) / 10,
  }));

  withDistance.sort((a, b) => a.distance_km - b.distance_km);

  // Get deliveries_today for top candidates
  const top = withDistance.slice(0, 5);
  for (const driver of top) {
    const today = new Date().toISOString().slice(0, 10);
    const count = await db.get(
      "SELECT COUNT(*) as c FROM orders WHERE driver_id = ? AND status = 'delivered' AND delivered_at >= ?",
      [driver.id, today]
    );
    driver.deliveries_today = count?.c || 0;
  }

  return top.slice(0, 3);
}

// ─── Admin API: Confirm or reject suggestion ─────────────────────────────────

// POST /api/ghosty/dispatch/confirm — Admin confirms the driver assignment
router.post("/confirm", requireAuth, requireRole("admin"), async (req, res) => {
  const { order_id, driver_id } = req.body || {};
  if (!order_id || !driver_id) {
    return res.status(400).json({ error: "order_id y driver_id son obligatorios" });
  }

  const order = await db.get("SELECT * FROM orders WHERE id = ?", [order_id]);
  if (!order) return res.status(404).json({ error: "Pedido no encontrado" });
  if (order.status !== "pending") {
    return res.status(400).json({ error: "El pedido ya fue asignado o procesado" });
  }

  const driver = await db.get(
    "SELECT u.id, u.name, d.status FROM users u JOIN drivers d ON d.user_id = u.id WHERE u.id = ?",
    [driver_id]
  );
  if (!driver) return res.status(404).json({ error: "Repartidor no encontrado" });

  // Assign the order
  await db.run(
    "UPDATE orders SET status = 'assigned', driver_id = ?, assigned_at = datetime('now') WHERE id = ?",
    [driver_id, order_id]
  );

  // Update driver status to busy
  await db.run("UPDATE drivers SET status = 'busy' WHERE user_id = ?", [driver_id]);

  const updatedOrder = await db.get("SELECT * FROM orders WHERE id = ?", [order_id]);

  // Notify via Socket.IO
  if (_io) {
    _io.to("admins").emit("order:status", updatedOrder);
    _io.to("driver:" + driver_id).emit("order:assigned", updatedOrder);
    _io.to("admins").emit("ghosty:confirmed", {
      order_id,
      order_code: order.code,
      driver_id,
      driver_name: driver.name,
    });
  }

  // Notify customer via WhatsApp
  if (order.customer_phone) {
    const msg = `🛵 ¡Tu pedido ${order.code} ya tiene repartidor! ${driver.name} va en camino a recogerlo. 👻`;
    sendTextMessage(order.customer_phone, msg).catch(() => {});
  }

  logger.info("Ghosty dispatch confirmed", {
    order: order.code,
    driver: driver.name,
    admin: req.user.name,
  });

  res.json({ ok: true, order: updatedOrder, driver_name: driver.name });
});

// POST /api/ghosty/dispatch/reject — Admin rejects suggestion (manual assignment)
router.post("/reject", requireAuth, requireRole("admin"), async (req, res) => {
  const { order_id } = req.body || {};
  if (!order_id) return res.status(400).json({ error: "order_id es obligatorio" });

  if (_io) {
    _io.to("admins").emit("ghosty:rejected", { order_id });
  }

  logger.info("Ghosty suggestion rejected", { order_id, admin: req.user.name });
  res.json({ ok: true, message: "Sugerencia rechazada. Asigna manualmente." });
});

// GET /api/ghosty/dispatch/suggestions — Get pending suggestions
router.get("/suggestions", requireAuth, requireRole("admin"), async (req, res) => {
  // Return pending orders created by Ghosty (code starts with GH-)
  const pending = await db.all(
    "SELECT * FROM orders WHERE status = 'pending' AND code LIKE 'GH-%' ORDER BY created_at DESC LIMIT 20"
  );

  const suggestions = [];
  for (const order of pending) {
    const drivers = await findNearestDrivers(order);
    suggestions.push({
      order,
      suggestions: drivers.map((d) => ({
        driver_id: d.id,
        driver_name: d.name,
        distance_km: d.distance_km,
        vehicle: d.vehicle,
        deliveries_today: d.deliveries_today || 0,
      })),
    });
  }

  res.json(suggestions);
});

export default router;
