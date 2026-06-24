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
            o.created_at, o.delivered_at,
            o.driver_id
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
      dropoff_address: order.dropoff_address,
      dropoff_lat: order.dropoff_lat,
      dropoff_lng: order.dropoff_lng,
      estimated_distance_km: order.estimated_distance_km,
      estimated_minutes: order.estimated_minutes,
      created_at: order.created_at,
      delivered_at: order.delivered_at,
    },
    driver,
    eta_minutes: eta,
    route,
  });
});

export default router;
