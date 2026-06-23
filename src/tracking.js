import { Router } from "express";
import db from "../db/database.js";
import { dynamicETA } from "./utils.js";

const router = Router();

// GET /api/track/:code - public tracking by order code (no auth required)
router.get("/:code", (req, res) => {
  const code = req.params.code;

  const order = db
    .prepare(
      `SELECT o.id, o.code, o.customer_name, o.status,
              o.pickup_address, o.pickup_lat, o.pickup_lng,
              o.dropoff_address, o.dropoff_lat, o.dropoff_lng,
              o.estimated_distance_km, o.estimated_minutes,
              o.amount, o.payment_method, o.created_at, o.delivered_at,
              o.driver_id
       FROM orders o
       WHERE o.code = ?`
    )
    .get(code);

  if (!order) {
    return res.status(404).json({ error: "Orden no encontrada" });
  }

  let driver = null;
  let eta = null;

  if (order.driver_id) {
    driver = db
      .prepare(
        `SELECT u.name, d.vehicle, d.plate, d.lat, d.lng
         FROM users u
         JOIN drivers d ON d.user_id = u.id
         WHERE u.id = ?`
      )
      .get(order.driver_id);

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

  res.json({
    order: {
      id: order.id,
      code: order.code,
      customer_name: order.customer_name,
      status: order.status,
      pickup_address: order.pickup_address,
      dropoff_address: order.dropoff_address,
      estimated_distance_km: order.estimated_distance_km,
      estimated_minutes: order.estimated_minutes,
      amount: order.amount,
      payment_method: order.payment_method,
      created_at: order.created_at,
      delivered_at: order.delivered_at,
    },
    driver,
    eta_minutes: eta,
  });
});

export default router;
