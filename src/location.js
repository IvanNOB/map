import { Router } from "express";
import db from "../db/database.js";
import { requireAuth } from "./auth.js";

/**
 * Location router factory.
 * Handles driver location history recording and route retrieval.
 * @param {import("socket.io").Server} io
 */
export default function createLocationRouter(io) {
  const router = Router();

  // POST /api/location - driver reports their location
  router.post("/", requireAuth, (req, res) => {
    if (req.user.role !== "driver") {
      return res.status(403).json({ error: "Solo repartidores pueden reportar ubicacion" });
    }

    const { lat, lng, order_id } = req.body || {};
    if (typeof lat !== "number" || typeof lng !== "number") {
      return res.status(400).json({ error: "lat y lng son obligatorios (numeros)" });
    }

    // Insert into location_history if order_id is provided
    if (order_id) {
      db.prepare(
        "INSERT INTO location_history (driver_id, order_id, lat, lng) VALUES (?, ?, ?, ?)"
      ).run(req.user.id, order_id, lat, lng);
    }

    res.json({ ok: true });
  });

  // GET /api/orders/:id/route - get location history for an order
  router.get("/orders/:id/route", requireAuth, (req, res) => {
    const points = db
      .prepare(
        "SELECT lat, lng, timestamp FROM location_history WHERE order_id = ? ORDER BY timestamp ASC"
      )
      .all(req.params.id);

    res.json(points);
  });

  return router;
}
