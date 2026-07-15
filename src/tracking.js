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
            o.dropoff_address, o.dropoff_lat, o.dropoff_lng, o.dropoff_confirmed,
            o.estimated_distance_km, o.estimated_minutes,
            o.created_at, o.assigned_at, o.picked_up_at, o.on_the_way_at, o.delivered_at,
            o.rating, o.review, o.driver_id
     FROM orders o
     WHERE o.code = ?`,
    [code]
  );

  if (!order) {
    return res.status(404).json({ error: "Orden no encontrada" });
  }

  let driver = null;
  let eta = null;

  // The customer should only see the driver's live position once the driver has
  // marked the order as "Recogido" (picked_up) and while it's on the way.
  // Before that (assigned) and after delivery/cancellation, the location is hidden.
  const ACTIVE_STATUSES = ["picked_up", "on_the_way"];
  const isActive = ACTIVE_STATUSES.includes(order.status);

  if (order.driver_id) {
    driver = await db.get(
      `SELECT u.name, d.vehicle, d.plate, d.lat, d.lng
       FROM users u
       JOIN drivers d ON d.user_id = u.id
       WHERE u.id = ?`,
      [order.driver_id]
    );

    if (driver && !isActive) {
      driver.lat = null;
      driver.lng = null;
    }

    // Calculate dynamic ETA only while the order is active and has positions.
    if (
      driver &&
      isActive &&
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

  const proof = await db.get("SELECT order_id FROM order_proofs WHERE order_id = ?", [order.id]);

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
      dropoff_confirmed: !!order.dropoff_confirmed,
      estimated_distance_km: order.estimated_distance_km,
      estimated_minutes: order.estimated_minutes,
      created_at: order.created_at,
      assigned_at: order.assigned_at,
      picked_up_at: order.picked_up_at,
      on_the_way_at: order.on_the_way_at,
      delivered_at: order.delivered_at,
      rating: order.rating,
      review: order.review,
      has_proof: !!proof,
    },
    driver,
    eta_minutes: eta,
    route,
  });
});

// GET /api/track/:code/proof - public proof image by order code
router.get("/:code/proof", async (req, res) => {
  const order = await db.get("SELECT id FROM orders WHERE code = ?", [req.params.code]);
  if (!order) return res.status(404).json({ error: "Orden no encontrada" });
  const proof = await db.get("SELECT image, created_at FROM order_proofs WHERE order_id = ?", [order.id]);
  if (!proof) return res.status(404).json({ error: "Sin prueba" });
  res.json(proof);
});

// POST /api/track/:code/rating - customer rates a delivered order (public)
router.post("/:code/rating", async (req, res) => {
  const { rating, comment } = req.body || {};
  const r = parseInt(rating, 10);
  if (!r || r < 1 || r > 5) {
    return res.status(400).json({ error: "La calificacion debe ser entre 1 y 5" });
  }

  const order = await db.get("SELECT id, status FROM orders WHERE code = ?", [req.params.code]);
  if (!order) return res.status(404).json({ error: "Orden no encontrada" });
  if (order.status !== "delivered") {
    return res.status(400).json({ error: "Solo se pueden calificar pedidos entregados" });
  }

  const review = comment ? String(comment).slice(0, 500) : null;
  await db.run("UPDATE orders SET rating = ?, review = ? WHERE id = ?", [r, review, order.id]);
  res.json({ ok: true, rating: r });
});

// POST /api/track/:code/address - customer confirms / sets their delivery address (public)
router.post("/:code/address", async (req, res) => {
  const { address, lat, lng } = req.body || {};

  const addr = address != null ? String(address).trim().slice(0, 300) : "";
  const hasCoords = lat != null && lng != null && !isNaN(Number(lat)) && !isNaN(Number(lng));

  if (!addr && !hasCoords) {
    return res.status(400).json({ error: "Escribe tu direccion o comparte tu ubicacion" });
  }

  const order = await db.get(
    "SELECT id, code, status, dropoff_address FROM orders WHERE code = ?",
    [req.params.code]
  );
  if (!order) return res.status(404).json({ error: "Orden no encontrada" });

  // Only allow the customer to set the address while the order is still in progress.
  if (order.status === "delivered" || order.status === "cancelled") {
    return res.status(400).json({ error: "Este pedido ya no se puede modificar" });
  }

  const finalAddress = addr || order.dropoff_address || "Ubicacion compartida por el cliente";

  await db.run(
    `UPDATE orders
        SET dropoff_address = ?,
            dropoff_lat = ?,
            dropoff_lng = ?,
            dropoff_confirmed = 1
      WHERE id = ?`,
    [finalAddress, hasCoords ? Number(lat) : null, hasCoords ? Number(lng) : null, order.id]
  );

  const updated = await db.get("SELECT * FROM orders WHERE id = ?", [order.id]);

  // Notify the admin panel (and any other customer tabs) in real time.
  const io = req.app.get("io");
  if (io) {
    io.to("admins").emit("order:address", {
      id: updated.id,
      code: updated.code,
      dropoff_address: updated.dropoff_address,
      dropoff_lat: updated.dropoff_lat,
      dropoff_lng: updated.dropoff_lng,
    });
    io.to("admins").emit("notification", {
      type: "address_confirmed",
      data: { code: updated.code, address: updated.dropoff_address },
    });
    // Notificar al repartidor asignado
    if (updated.driver_id) {
      io.to(`driver:${updated.driver_id}`).emit("order:address", {
        id: updated.id,
        code: updated.code,
        dropoff_address: updated.dropoff_address,
        dropoff_lat: updated.dropoff_lat,
        dropoff_lng: updated.dropoff_lng,
      });
    }
    io.to(`tracking:${updated.code}`).emit("order:status", updated);
  }

  res.json({
    ok: true,
    dropoff_address: updated.dropoff_address,
    dropoff_lat: updated.dropoff_lat,
    dropoff_lng: updated.dropoff_lng,
  });
});

export default router;
