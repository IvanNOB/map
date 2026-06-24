import { Router } from "express";
import db from "../db/database.js";
import { dynamicETA } from "./utils.js";

const router = Router();

// GET /api/track/:code - public tracking by order code (no auth required)
router.get("/:code", async (req, res) => {
  const code = req.params.code;

  const order = await db.get(
    `SELECT o.id, o.code, o.customer_name, o.status,
            o.pickup_address, o.pickup_lat, o.pickup_lng,
            o.dropoff_address, o.dropoff_lat, o.dropoff_lng,
            o.estimated_distance_km, o.estimated_minutes,
            o.created_at, o.assigned_at, o.picked_up_at, o.on_the_way_at, o.delivered_at,
            o.rating, o.driver_id
     FROM orders o
     WHERE o.code = ?`,
    [code]
  );

  if (!order) {
    return res.status(404).json({ error: "Orden no encontrada" });
  }

  let driver = null;
  let eta = null;

  if (order.driver_id) {
    driver = await db.get(
      `SELECT u.name, d.vehicle, d.plate, d.lat, d.lng
       FROM users u
       JOIN drivers d ON d.user_id = u.id
       WHERE u.id = ?`,
      [order.driver_id]
    );

    // Calculate dynamic ETA if driver has a position and order has dropoff coordinates
    if (
      driver &&
      driver.lat != null &&
      driver.lng != null &&
      order.dropoff_lat != null &&
      order.dropoff_lng != null
    ) {
      eta = dynamicETA(driver.lat, driver.lng, order.dropoff_lat, order.dropoff_lng);
    }
  }

  // Fetch location history (route) for this order
  const route = await db.all(
    `SELECT lat, lng, timestamp FROM location_history
     WHERE order_id = ? ORDER BY timestamp ASC`,
    [order.id]
  );

  res.json({
    order: {
      id: order.id,
      code: order.code,
      customer_name: order.customer_name,
      status: order.status,
      pickup_address: order.pickup_address,
      pickup_lat: order.pickup_lat,
      pickup_lng: order.pickup_lng,
      dropoff_address: order.dropoff_address,
      dropoff_lat: order.dropoff_lat,
      dropoff_lng: order.dropoff_lng,
      estimated_distance_km: order.estimated_distance_km,
      estimated_minutes: order.estimated_minutes,
      created_at: order.created_at,
      assigned_at: order.assigned_at,
      picked_up_at: order.picked_up_at,
      on_the_way_at: order.on_the_way_at,
      delivered_at: order.delivered_at,
      rating: order.rating,
    },
    driver,
    eta_minutes: eta,
    route,
  });
});

// POST /api/track/:code/rating - customer rates a delivered order (public)
router.post("/:code/rating", async (req, res) => {
  const { rating } = req.body || {};
  const r = parseInt(rating, 10);
  if (!r || r < 1 || r > 5) {
    return res.status(400).json({ error: "La calificacion debe ser entre 1 y 5" });
  }

  const order = await db.get("SELECT id, status FROM orders WHERE code = ?", [req.params.code]);
  if (!order) return res.status(404).json({ error: "Orden no encontrada" });
  if (order.status !== "delivered") {
    return res.status(400).json({ error: "Solo se pueden calificar pedidos entregados" });
  }

  await db.run("UPDATE orders SET rating = ? WHERE id = ?", [r, order.id]);
  res.json({ ok: true, rating: r });
});

export default router;
