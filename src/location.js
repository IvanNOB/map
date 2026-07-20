import { Router } from "express";
import db from "../db/database.js";
import { requireAuth } from "./auth.js";
import { notifyAdmins } from "./notifications.js";

/**
 * Location router factory.
 * Handles driver location history recording, batch uploads from background sync,
 * and route retrieval.
 * @param {import("socket.io").Server} io
 */
export default function createLocationRouter(io) {
  const router = Router();

  // POST /api/location - driver reports their location (single point)
  router.post("/", requireAuth, (req, res) => {
    if (req.user.role !== "driver") {
      return res.status(403).json({ error: "Solo repartidores pueden reportar ubicacion" });
    }

    const { lat, lng, order_id } = req.body || {};
    if (typeof lat !== "number" || typeof lng !== "number") {
      return res.status(400).json({ error: "lat y lng son obligatorios (numeros)" });
    }

    // Update driver position
    db.prepare(
      `UPDATE drivers SET lat = ?, lng = ?, last_seen = datetime('now'), status = 'available'
       WHERE user_id = ?`
    ).run(lat, lng, req.user.id);

    // Broadcast to admins
    io.to("admins").emit("driver:location", {
      id: req.user.id,
      name: req.user.name,
      lat,
      lng,
      speed: 0,
      last_seen: new Date().toISOString(),
    });

    // Insert into location_history if order_id is provided
    if (order_id) {
      db.prepare(
        "INSERT INTO location_history (driver_id, order_id, lat, lng) VALUES (?, ?, ?, ?)"
      ).run(req.user.id, order_id, lat, lng);
    }

    res.json({ ok: true });
  });

  // ─── POST /api/location/batch — Background Sync batch upload ──────────────
  // Receives an array of location points queued by the Service Worker
  // when the app was in the background or offline.
  router.post("/batch", requireAuth, (req, res) => {
    if (req.user.role !== "driver") {
      return res.status(403).json({ error: "Solo repartidores pueden reportar ubicacion" });
    }

    const { locations } = req.body || {};
    if (!Array.isArray(locations) || locations.length === 0) {
      return res.status(400).json({ error: "Se requiere un array 'locations' con al menos un punto" });
    }

    // Limit batch size to prevent abuse
    const MAX_BATCH_SIZE = 200;
    const batch = locations.slice(0, MAX_BATCH_SIZE);
    const driverId = req.user.id;

    let processed = 0;
    let latestLat = null;
    let latestLng = null;
    let latestSpeed = 0;

    // Get active orders for this driver (to record location history)
    const activeOrders = db
      .prepare(
        "SELECT id, code FROM orders WHERE driver_id = ? AND status IN ('assigned', 'picked_up', 'on_the_way')"
      )
      .all(driverId);

    // Process each location point
    for (const loc of batch) {
      if (typeof loc.lat !== "number" || typeof loc.lng !== "number") {
        continue; // Skip invalid points
      }

      latestLat = loc.lat;
      latestLng = loc.lng;
      latestSpeed = typeof loc.speed === "number" ? loc.speed : 0;

      // Record in location_history for each active order
      for (const order of activeOrders) {
        db.prepare(
          "INSERT INTO location_history (driver_id, order_id, lat, lng, timestamp) VALUES (?, ?, ?, ?, ?)"
        ).run(
          driverId,
          order.id,
          loc.lat,
          loc.lng,
          loc.timestamp || new Date().toISOString()
        );
      }

      processed++;
    }

    // Update driver's current position with the latest point
    if (latestLat !== null && latestLng !== null) {
      db.prepare(
        `UPDATE drivers SET lat = ?, lng = ?, speed = ?, last_seen = datetime('now'), status = 'available'
         WHERE user_id = ?`
      ).run(latestLat, latestLng, latestSpeed, driverId);

      // Broadcast latest position to admins
      io.to("admins").emit("driver:location", {
        id: driverId,
        name: req.user.name,
        lat: latestLat,
        lng: latestLng,
        speed: latestSpeed,
        last_seen: new Date().toISOString(),
        source: "background_sync",
      });

      // Emit to tracking rooms for active orders
      for (const order of activeOrders) {
        io.to(`tracking:${order.code}`).emit("driver:location", {
          id: driverId,
          name: req.user.name,
          lat: latestLat,
          lng: latestLng,
          speed: latestSpeed,
        });
      }
    }

    res.json({
      ok: true,
      processed,
      total_received: batch.length,
      skipped: batch.length - processed,
    });
  });

  // GET /api/location/orders/:id/route - get location history for an order
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
