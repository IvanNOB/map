import { Router } from "express";
import db, { COUNT_INT } from "../db/database.js";
import { requireAuth, requireRole } from "./auth.js";
import { haversineDistance, estimateTime, getRoute } from "./utils.js";
import { notifyAdmins, notifyDriver } from "./notifications.js";
import { logActivity } from "./activity.js";
import { sendPush } from "./push.js";
import { sendWhatsApp } from "./whatsapp.js";

/**
 * Orders router factory.
 * Receives the Socket.IO `io` instance so it can emit real-time events.
 */
export default function createOrdersRouter(io) {
  const router = Router();

  // ─── Helpers ───────────────────────────────────────────────────────────────

  function generateCode() {
    const ts = Date.now().toString(36).toUpperCase().slice(-4);
    return `ORD-${ts}${Math.random().toString(36).slice(2, 4).toUpperCase()}`;
  }

  // date(col) = ?  vs  col::date = ?::date
  const dateEq = (col) => (db.isPostgres ? `${col}::date = ?::date` : `date(${col}) = ?`);

  // ─── GET /api/orders ───────────────────────────────────────────────────────

  router.get("/", requireAuth, async (req, res) => {
    const { role, id: userId } = req.user;

    if (role === "admin") {
      const { status } = req.query;
      if (status) {
        const orders = await db.all(
          "SELECT * FROM orders WHERE status = ? ORDER BY created_at DESC",
          [status]
        );
        return res.json(orders);
      }
      const orders = await db.all("SELECT * FROM orders ORDER BY created_at DESC");
      return res.json(orders);
    }

    // Driver sees only their assigned orders
    const orders = await db.all(
      "SELECT * FROM orders WHERE driver_id = ? ORDER BY created_at DESC",
      [userId]
    );
    res.json(orders);
  });

  // ─── GET /api/orders/stats ───────────────────────────────────────────────────
  // NOTE: Must be defined BEFORE /:id to avoid "stats" being treated as an id

  router.get("/stats", requireAuth, requireRole("admin"), async (req, res) => {
    const today = new Date().toISOString().slice(0, 10);

    const ordersToday = (
      await db.get(`SELECT ${COUNT_INT} as count FROM orders WHERE ${dateEq("created_at")}`, [today])
    ).count;

    const deliveriesToday = (
      await db.get(
        `SELECT ${COUNT_INT} as count FROM orders WHERE status = 'delivered' AND ${dateEq("delivered_at")}`,
        [today]
      )
    ).count;

    const activeOrders = (
      await db.get(
        `SELECT ${COUNT_INT} as count FROM orders WHERE status IN ('assigned', 'picked_up', 'on_the_way')`
      )
    ).count;

    const availableDrivers = (
      await db.get(`SELECT ${COUNT_INT} as count FROM drivers WHERE status = 'available'`)
    ).count;

    const revenueToday = (
      await db.get(
        `SELECT COALESCE(SUM(amount), 0) as total FROM orders WHERE status = 'delivered' AND ${dateEq("delivered_at")}`,
        [today]
      )
    ).total;

    res.json({
      orders_today: Number(ordersToday),
      deliveries_today: Number(deliveriesToday),
      active_orders: Number(activeOrders),
      available_drivers: Number(availableDrivers),
      revenue_today: Number(revenueToday),
    });
  });

  // ─── GET /api/orders/:id/route ─────────────────────────────────────────────

  router.get("/:id/route", requireAuth, async (req, res) => {
    const order = await db.get("SELECT id FROM orders WHERE id = ?", [req.params.id]);
    if (!order) return res.status(404).json({ error: "Orden no encontrada" });

    const route = await db.all(
      "SELECT lat, lng, timestamp FROM location_history WHERE order_id = ? ORDER BY timestamp ASC",
      [req.params.id]
    );

    res.json(route);
  });

  // ─── Proof of delivery ──────────────────────────────────────────────────────

  // POST /api/orders/:id/proof - driver (own order) or admin uploads a photo (data URL)
  router.post("/:id/proof", requireAuth, async (req, res) => {
    const { image } = req.body || {};
    if (!image || typeof image !== "string" || !image.startsWith("data:image/")) {
      return res.status(400).json({ error: "Imagen invalida" });
    }
    if (image.length > 1500000) {
      return res.status(413).json({ error: "La imagen es demasiado grande" });
    }
    const order = await db.get("SELECT id, driver_id, code FROM orders WHERE id = ?", [req.params.id]);
    if (!order) return res.status(404).json({ error: "Orden no encontrada" });
    if (req.user.role === "driver" && order.driver_id !== req.user.id) {
      return res.status(403).json({ error: "No autorizado para esta orden" });
    }

    await db.run(
      "INSERT INTO order_proofs (order_id, image) VALUES (?, ?) ON CONFLICT(order_id) DO UPDATE SET image = excluded.image",
      [order.id, image]
    );
    logActivity(req.user, "proof_uploaded", "Prueba de entrega para " + order.code);
    res.json({ ok: true });
  });

  // GET /api/orders/:id/proof - view proof (admin or assigned driver)
  router.get("/:id/proof", requireAuth, async (req, res) => {
    const order = await db.get("SELECT id, driver_id FROM orders WHERE id = ?", [req.params.id]);
    if (!order) return res.status(404).json({ error: "Orden no encontrada" });
    if (req.user.role === "driver" && order.driver_id !== req.user.id) {
      return res.status(403).json({ error: "No autorizado" });
    }
    const proof = await db.get("SELECT image, created_at FROM order_proofs WHERE order_id = ?", [order.id]);
    if (!proof) return res.status(404).json({ error: "Sin prueba de entrega" });
    res.json(proof);
  });

  // ─── GET /api/orders/:id ───────────────────────────────────────────────────

  router.get("/:id", requireAuth, async (req, res) => {
    const order = await db.get("SELECT * FROM orders WHERE id = ?", [req.params.id]);
    if (!order) return res.status(404).json({ error: "Orden no encontrada" });

    // Drivers can only view their own assigned orders
    if (req.user.role === "driver" && order.driver_id !== req.user.id) {
      return res.status(403).json({ error: "No autorizado para esta orden" });
    }

    res.json(order);
  });

  // ─── POST /api/orders ─────────────────────────────────────────────────────

  router.post("/", requireAuth, requireRole("admin"), async (req, res) => {
    const {
      customer_name,
      customer_phone,
      pickup_address,
      pickup_lat,
      pickup_lng,
      dropoff_address,
      dropoff_lat,
      dropoff_lng,
      items,
      notes,
      amount,
      payment_method,
      scheduled_at,
      branch_id,
    } = req.body || {};

    if (!customer_name || !pickup_address || !dropoff_address) {
      return res.status(400).json({ error: "customer_name, pickup_address y dropoff_address son obligatorios" });
    }

    // Retry loop to handle code collisions (UNIQUE constraint on code)
    const MAX_RETRIES = 5;
    let order = null;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const code = generateCode();
      try {
        const info = await db.run(
          `INSERT INTO orders (code, customer_name, customer_phone, pickup_address, pickup_lat, pickup_lng,
                               dropoff_address, dropoff_lat, dropoff_lng, items, notes, amount, payment_method)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            code,
            customer_name,
            customer_phone || null,
            pickup_address,
            pickup_lat || null,
            pickup_lng || null,
            dropoff_address,
            dropoff_lat || null,
            dropoff_lng || null,
            items || null,
            notes || null,
            amount || 0,
            payment_method || "cash",
          ]
        );
        order = await db.get("SELECT * FROM orders WHERE id = ?", [info.lastInsertRowid]);
        break;
      } catch (err) {
        // UNIQUE constraint violation on code -> retry with a new code
        const isUnique =
          err.code === "23505" ||
          (err.message && (err.message.includes("UNIQUE") || err.message.toLowerCase().includes("duplicate")));
        if (isUnique) {
          if (attempt === MAX_RETRIES - 1) {
            return res.status(500).json({ error: "No se pudo generar un codigo unico para la orden" });
          }
          continue;
        }
        console.error("Error creating order:", err.message);
        return res.status(500).json({ error: "Error al crear la orden" });
      }
    }

    // Calculate estimated distance and time if coordinates are provided.
    // Prefer the real road route (OSRM); fall back to straight-line estimate.
    if (pickup_lat && pickup_lng && dropoff_lat && dropoff_lng) {
      let distance, minutes;
      const route = await getRoute(pickup_lat, pickup_lng, dropoff_lat, dropoff_lng);
      if (route) {
        distance = route.distanceKm;
        minutes = route.minutes;
      } else {
        distance = haversineDistance(pickup_lat, pickup_lng, dropoff_lat, dropoff_lng);
        minutes = estimateTime(distance);
      }
      await db.run("UPDATE orders SET estimated_distance_km = ?, estimated_minutes = ? WHERE id = ?", [
        Math.round(distance * 100) / 100,
        Math.round(minutes * 10) / 10,
        order.id,
      ]);
      order = await db.get("SELECT * FROM orders WHERE id = ?", [order.id]);
    }

    // Optional scheduled time
    if (scheduled_at) {
      await db.run("UPDATE orders SET scheduled_at = ? WHERE id = ?", [scheduled_at, order.id]);
      order = await db.get("SELECT * FROM orders WHERE id = ?", [order.id]);
    }

    // Optional branch
    if (branch_id) {
      await db.run("UPDATE orders SET branch_id = ? WHERE id = ?", [branch_id, order.id]);
      order = await db.get("SELECT * FROM orders WHERE id = ?", [order.id]);
    }

    // Emit to admins
    io.to("admins").emit("order:new", order);
    notifyAdmins(io, "order_new", order);
    logActivity(req.user, "order_created", "Pedido " + order.code + " creado");
    // Push to all admins
    db.all("SELECT id FROM users WHERE role = 'admin'").then((admins) => {
      admins.forEach((a) => sendPush(a.id, { title: "Nuevo pedido", body: order.code + " - " + order.customer_name, url: "/" }));
    }).catch(() => {});

    res.status(201).json(order);
  });

  // ─── PUT /api/orders/:id ───────────────────────────────────────────────────

  router.put("/:id", requireAuth, requireRole("admin"), async (req, res) => {
    const existing = await db.get("SELECT * FROM orders WHERE id = ?", [req.params.id]);
    if (!existing) return res.status(404).json({ error: "Orden no encontrada" });

    const {
      customer_name,
      customer_phone,
      pickup_address,
      pickup_lat,
      pickup_lng,
      dropoff_address,
      dropoff_lat,
      dropoff_lng,
      items,
      notes,
      amount,
      payment_method,
    } = req.body || {};

    await db.run(
      `UPDATE orders SET
         customer_name = COALESCE(?, customer_name),
         customer_phone = COALESCE(?, customer_phone),
         pickup_address = COALESCE(?, pickup_address),
         pickup_lat = COALESCE(?, pickup_lat),
         pickup_lng = COALESCE(?, pickup_lng),
         dropoff_address = COALESCE(?, dropoff_address),
         dropoff_lat = COALESCE(?, dropoff_lat),
         dropoff_lng = COALESCE(?, dropoff_lng),
         items = COALESCE(?, items),
         notes = COALESCE(?, notes),
         amount = COALESCE(?, amount),
         payment_method = COALESCE(?, payment_method)
       WHERE id = ?`,
      [
        customer_name || null,
        customer_phone || null,
        pickup_address || null,
        pickup_lat || null,
        pickup_lng || null,
        dropoff_address || null,
        dropoff_lat || null,
        dropoff_lng || null,
        items || null,
        notes || null,
        amount != null ? amount : null,
        payment_method || null,
        req.params.id,
      ]
    );

    const order = await db.get("SELECT * FROM orders WHERE id = ?", [req.params.id]);
    res.json(order);
  });

  // ─── POST /api/orders/:id/assign ───────────────────────────────────────────

  router.post("/:id/assign", requireAuth, requireRole("admin"), async (req, res) => {
    const { driver_id } = req.body || {};
    if (!driver_id) return res.status(400).json({ error: "driver_id es obligatorio" });

    const order = await db.get("SELECT * FROM orders WHERE id = ?", [req.params.id]);
    if (!order) return res.status(404).json({ error: "Orden no encontrada" });

    // Verify driver exists
    const driver = await db.get("SELECT user_id FROM drivers WHERE user_id = ?", [driver_id]);
    if (!driver) return res.status(404).json({ error: "Conductor no encontrado" });

    await db.run(
      "UPDATE orders SET driver_id = ?, status = 'assigned', assigned_at = datetime('now') WHERE id = ?",
      [driver_id, req.params.id]
    );

    const updated = await db.get("SELECT * FROM orders WHERE id = ?", [req.params.id]);

    // Notify admins and the assigned driver
    io.to("admins").emit("order:assigned", updated);
    io.to(`driver:${driver_id}`).emit("order:assigned", updated);
    notifyDriver(io, driver_id, "order_assigned", updated);

    // Emit to tracking room
    io.to(`tracking:${updated.code}`).emit("order:assigned", updated);

    logActivity(req.user, "order_assigned", "Pedido " + updated.code + " asignado a repartidor " + driver_id);
    sendPush(driver_id, { title: "Nuevo pedido asignado", body: updated.code + " - " + updated.dropoff_address, url: "/driver.html" });

    // Auto WhatsApp to customer (only if Twilio is configured)
    if (updated.customer_phone) {
      const base = process.env.PUBLIC_URL || `${req.protocol}://${req.get("host")}`;
      const link = `${base}/customer.html?code=${encodeURIComponent(updated.code)}`;
      sendWhatsApp(updated.customer_phone, `Tu pedido ${updated.code} ya tiene repartidor. Sigue la entrega aqui: ${link}`);
    }

    res.json(updated);
  });

  // ─── POST /api/orders/:id/auto-assign ──────────────────────────────────────
  // Assigns the order to the nearest AVAILABLE driver (by pickup location).

  router.post("/:id/auto-assign", requireAuth, requireRole("admin"), async (req, res) => {
    const order = await db.get("SELECT * FROM orders WHERE id = ?", [req.params.id]);
    if (!order) return res.status(404).json({ error: "Orden no encontrada" });

    // Candidate drivers that are available
    const available = await db.all(
      `SELECT u.id, u.name, d.lat, d.lng
       FROM users u JOIN drivers d ON d.user_id = u.id
       WHERE u.role = 'driver' AND d.status = 'available'`
    );
    if (available.length === 0) {
      return res.status(409).json({ error: "No hay repartidores disponibles en este momento" });
    }

    // Pick nearest to pickup if coords available, otherwise the first available
    let chosen = available[0];
    if (order.pickup_lat != null && order.pickup_lng != null) {
      const withCoords = available.filter((d) => d.lat != null && d.lng != null);
      if (withCoords.length > 0) {
        chosen = withCoords.reduce((best, d) => {
          const dist = haversineDistance(order.pickup_lat, order.pickup_lng, d.lat, d.lng);
          return dist < best._dist ? Object.assign({}, d, { _dist: dist }) : best;
        }, Object.assign({}, withCoords[0], { _dist: Infinity }));
      }
    }

    await db.run(
      "UPDATE orders SET driver_id = ?, status = 'assigned', assigned_at = datetime('now') WHERE id = ?",
      [chosen.id, req.params.id]
    );
    const updated = await db.get("SELECT * FROM orders WHERE id = ?", [req.params.id]);

    io.to("admins").emit("order:assigned", updated);
    io.to(`driver:${chosen.id}`).emit("order:assigned", updated);
    notifyDriver(io, chosen.id, "order_assigned", updated);
    io.to(`tracking:${updated.code}`).emit("order:assigned", updated);

    logActivity(req.user, "order_auto_assigned", "Pedido " + updated.code + " auto-asignado a " + chosen.name);
    sendPush(chosen.id, { title: "Nuevo pedido asignado", body: updated.code + " - " + updated.dropoff_address, url: "/driver.html" });

    if (updated.customer_phone) {
      const base = process.env.PUBLIC_URL || `${req.protocol}://${req.get("host")}`;
      const link = `${base}/customer.html?code=${encodeURIComponent(updated.code)}`;
      sendWhatsApp(updated.customer_phone, `Tu pedido ${updated.code} ya tiene repartidor (${chosen.name}). Sigue la entrega aqui: ${link}`);
    }

    res.json({ order: updated, driver_name: chosen.name });
  });

  // ─── POST /api/orders/:id/status ───────────────────────────────────────────

  router.post("/:id/status", requireAuth, async (req, res) => {
    const { status } = req.body || {};
    const order = await db.get("SELECT * FROM orders WHERE id = ?", [req.params.id]);
    if (!order) return res.status(404).json({ error: "Orden no encontrada" });

    // Drivers can only update their own orders
    if (req.user.role === "driver" && order.driver_id !== req.user.id) {
      return res.status(403).json({ error: "No autorizado para esta orden" });
    }

    const workflow = {
      assigned: "picked_up",
      picked_up: "on_the_way",
      on_the_way: "delivered",
    };

    const nextAllowed = workflow[order.status];
    if (!nextAllowed || nextAllowed !== status) {
      return res.status(400).json({
        error: `Transicion invalida: ${order.status} -> ${status}`,
        allowed: nextAllowed || null,
      });
    }

    if (status === "delivered") {
      await db.run("UPDATE orders SET status = ?, delivered_at = datetime('now') WHERE id = ?", [
        status,
        req.params.id,
      ]);
    } else if (status === "picked_up") {
      await db.run("UPDATE orders SET status = ?, picked_up_at = datetime('now') WHERE id = ?", [
        status,
        req.params.id,
      ]);
    } else if (status === "on_the_way") {
      await db.run("UPDATE orders SET status = ?, on_the_way_at = datetime('now') WHERE id = ?", [
        status,
        req.params.id,
      ]);
    } else {
      await db.run("UPDATE orders SET status = ? WHERE id = ?", [status, req.params.id]);
    }

    const updated = await db.get("SELECT * FROM orders WHERE id = ?", [req.params.id]);

    // Notify admins
    io.to("admins").emit("order:status", updated);

    // Emit to tracking room
    io.to(`tracking:${updated.code}`).emit("order:status", updated);

    if (status === "delivered") {
      notifyAdmins(io, "order_delivered", updated);
    }
    logActivity(req.user, "order_status", "Pedido " + updated.code + " -> " + status);

    res.json(updated);
  });

  // ─── DELETE /api/orders/:id ────────────────────────────────────────────────

  router.delete("/:id", requireAuth, requireRole("admin"), async (req, res) => {
    const order = await db.get("SELECT * FROM orders WHERE id = ?", [req.params.id]);
    if (!order) return res.status(404).json({ error: "Orden no encontrada" });

    await db.run("UPDATE orders SET status = 'cancelled' WHERE id = ?", [req.params.id]);

    const updated = await db.get("SELECT * FROM orders WHERE id = ?", [req.params.id]);
    io.to("admins").emit("order:status", updated);

    logActivity(req.user, "order_cancelled", "Pedido " + updated.code + " cancelado");

    res.json(updated);
  });

  return router;
}
