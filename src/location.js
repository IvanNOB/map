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
  router.post("/", requireAuth, async (req, res) => {
    if (req.user.role !== "driver") {
      return res.status(403).json({ error: "Solo repartidores pueden reportar ubicacion" });
    }

    const { lat, lng, order_id } = req.body || {};
    if (typeof lat !== "number" || typeof lng !== "number") {
      return res.status(400).json({ error: "lat y lng son obligatorios (numeros)" });
    }

    // Insert into location_history if order_id is provided
    if (order_id) {
      await db.run(
        "INSERT INTO location_history (driver_id, order_id, lat, lng) VALUES (?, ?, ?, ?)",
        [req.user.id, order_id, lat, lng]
      );
    }

    res.json({ ok: true });
  });

  // POST /api/location/ping - driver reports position over HTTP (reliable in background)
  // Updates the driver's position, broadcasts to admins, and records history for active orders.
  router.post("/ping", requireAuth, async (req, res) => {
    if (req.user.role !== "driver") {
      return res.status(403).json({ error: "Solo repartidores pueden reportar ubicacion" });
    }
    const { lat, lng, speed } = req.body || {};
    if (typeof lat !== "number" || typeof lng !== "number") {
      return res.status(400).json({ error: "lat y lng son obligatorios (numeros)" });
    }
    const sp = typeof speed === "number" ? speed : 0;

    await db.run(
      "UPDATE drivers SET lat = ?, lng = ?, speed = ?, last_seen = datetime('now'), status = 'available' WHERE user_id = ?",
      [lat, lng, sp, req.user.id]
    );

    io.to("admins").emit("driver:location", {
      id: req.user.id,
      name: req.user.name,
      lat,
      lng,
      speed: sp,
      last_seen: new Date().toISOString(),
    });

    const active = await db.all(
      "SELECT id, code FROM orders WHERE driver_id = ? AND status IN ('picked_up','on_the_way')",
      [req.user.id]
    );
    for (const o of active) {
      await db.run(
        "INSERT INTO location_history (driver_id, order_id, lat, lng) VALUES (?, ?, ?, ?)",
        [req.user.id, o.id, lat, lng]
      );
      io.to(`tracking:${o.code}`).emit("driver:location", {
        id: req.user.id, name: req.user.name, lat, lng, speed: sp,
      });
    }

    res.json({ ok: true });
  });

  // POST /api/location/offline - driver stops sharing (sets offline)
  router.post("/offline", requireAuth, async (req, res) => {
    if (req.user.role !== "driver") return res.status(403).json({ error: "No autorizado" });
    await db.run("UPDATE drivers SET status = 'offline', last_seen = datetime('now') WHERE user_id = ?", [req.user.id]);
    io.to("admins").emit("driver:offline", { id: req.user.id });
    res.json({ ok: true });
  });

  // GET /api/orders/:id/route - get location history for an order
  router.get("/orders/:id/route", requireAuth, async (req, res) => {
    const points = await db.all(
      "SELECT lat, lng, timestamp FROM location_history WHERE order_id = ? ORDER BY timestamp ASC",
      [req.params.id]
    );

    res.json(points);
  });

  return router;
}
