import { Router } from "express";
import db from "../db/database.js";
import { requireAuth, requireRole } from "./auth.js";
import { haversineDistance, estimateTime, formatColombianPhone } from "./utils.js";
import { notifyAdmins, notifyDriver } from "./notifications.js";

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

  // ─── GET /api/orders ───────────────────────────────────────────────────────

  router.get("/", requireAuth, (req, res) => {
    const { role, id: userId } = req.user;

    if (role === "admin") {
      const { status, search, page = 1, limit = 50 } = req.query;
      const pageNum = Math.max(1, parseInt(page) || 1);
      const limitNum = Math.min(200, Math.max(1, parseInt(limit) || 50));
      const offset = (pageNum - 1) * limitNum;

      let whereClause = "WHERE 1=1";
      const params = [];

      if (status) {
        whereClause += " AND status = ?";
        params.push(status);
      }

      if (search && search.trim()) {
        const term = `%${search.trim()}%`;
        whereClause += " AND (customer_name LIKE ? OR customer_phone LIKE ? OR code LIKE ? OR pickup_address LIKE ? OR dropoff_address LIKE ?)";
        params.push(term, term, term, term, term);
      }

      // Get total count
      const countRow = db
        .prepare(`SELECT COUNT(*) as total FROM orders ${whereClause}`)
        .get(...params);
      const total = countRow.total;

      // Get paginated results
      const orders = db
        .prepare(`SELECT * FROM orders ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
        .all(...params, limitNum, offset);

      return res.json({
        orders,
        pagination: {
          page: pageNum,
          limit: limitNum,
          total,
          pages: Math.ceil(total / limitNum),
        },
      });
    }

    // Driver sees only their assigned orders (no pagination needed, usually small)
    const orders = db
      .prepare("SELECT * FROM orders WHERE driver_id = ? ORDER BY created_at DESC")
      .all(userId);
    res.json(orders);
  });

  // ─── GET /api/orders/stats ───────────────────────────────────────────────────
  // NOTE: Must be defined BEFORE /:id to avoid "stats" being treated as an id

  router.get("/stats", requireAuth, requireRole("admin"), (req, res) => {
    const today = new Date().toISOString().slice(0, 10);

    const ordersToday = db
      .prepare("SELECT COUNT(*) as count FROM orders WHERE date(created_at) = ?")
      .get(today).count;

    const deliveriesToday = db
      .prepare("SELECT COUNT(*) as count FROM orders WHERE status = 'delivered' AND date(delivered_at) = ?")
      .get(today).count;

    const activeOrders = db
      .prepare("SELECT COUNT(*) as count FROM orders WHERE status IN ('assigned', 'picked_up', 'on_the_way')")
      .get().count;

    const availableDrivers = db
      .prepare("SELECT COUNT(*) as count FROM drivers WHERE status = 'available'")
      .get().count;

    const revenueToday = db
      .prepare("SELECT COALESCE(SUM(amount), 0) as total FROM orders WHERE status = 'delivered' AND date(delivered_at) = ?")
      .get(today).total;

    res.json({
      orders_today: ordersToday,
      deliveries_today: deliveriesToday,
      active_orders: activeOrders,
      available_drivers: availableDrivers,
      revenue_today: revenueToday,
    });
  });

  // ─── GET /api/orders/:id/route ─────────────────────────────────────────────

  router.get("/:id/route", requireAuth, (req, res) => {
    const order = db.prepare("SELECT id FROM orders WHERE id = ?").get(req.params.id);
    if (!order) return res.status(404).json({ error: "Orden no encontrada" });

    const route = db
      .prepare(
        "SELECT lat, lng, timestamp FROM location_history WHERE order_id = ? ORDER BY timestamp ASC"
      )
      .all(req.params.id);

    res.json(route);
  });

  // ─── GET /api/orders/:id ───────────────────────────────────────────────────

  router.get("/:id", requireAuth, (req, res) => {
    const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(req.params.id);
    if (!order) return res.status(404).json({ error: "Orden no encontrada" });

    // Drivers can only view their own assigned orders
    if (req.user.role === "driver" && order.driver_id !== req.user.id) {
      return res.status(403).json({ error: "No autorizado para esta orden" });
    }

    res.json(order);
  });

  // ─── POST /api/orders ─────────────────────────────────────────────────────

  router.post("/", requireAuth, requireRole("admin"), (req, res) => {
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

    if (!customer_name || !pickup_address || !dropoff_address) {
      return res.status(400).json({ error: "customer_name, pickup_address y dropoff_address son obligatorios" });
    }

    // Validate and format Colombian phone number if provided
    let formattedPhone = null;
    if (customer_phone && String(customer_phone).trim()) {
      formattedPhone = formatColombianPhone(customer_phone);
      if (!formattedPhone) {
        return res.status(400).json({ error: "Numero de telefono invalido. Debe ser un numero colombiano valido (ej: 3001234567 o +573001234567)" });
      }
    }

    // Retry loop to handle code collisions (UNIQUE constraint on code)
    const MAX_RETRIES = 5;
    let order = null;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const code = generateCode();
      try {
        const info = db
          .prepare(
            `INSERT INTO orders (code, customer_name, customer_phone, pickup_address, pickup_lat, pickup_lng,
                                 dropoff_address, dropoff_lat, dropoff_lng, items, notes, amount, payment_method)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            code,
            customer_name,
            formattedPhone,
            pickup_address,
            pickup_lat || null,
            pickup_lng || null,
            dropoff_address,
            dropoff_lat || null,
            dropoff_lng || null,
            items || null,
            notes || null,
            amount || 0,
            payment_method || "cash"
          );
        order = db.prepare("SELECT * FROM orders WHERE id = ?").get(info.lastInsertRowid);
        break;
      } catch (err) {
        // If it's a UNIQUE constraint error on code, retry with a new code
        if (err.message && (err.message.includes("UNIQUE") || err.message.includes("unique"))) {
          if (attempt === MAX_RETRIES - 1) {
            return res.status(500).json({ error: "No se pudo generar un codigo unico para la orden" });
          }
          continue;
        }
        // For any other DB error, return 500
        console.error("Error creating order:", err.message);
        return res.status(500).json({ error: "Error al crear la orden" });
      }
    }

    // Calculate estimated distance and time if coordinates are provided
    if (pickup_lat && pickup_lng && dropoff_lat && dropoff_lng) {
      const distance = haversineDistance(pickup_lat, pickup_lng, dropoff_lat, dropoff_lng);
      const minutes = estimateTime(distance);
      db.prepare(
        "UPDATE orders SET estimated_distance_km = ?, estimated_minutes = ? WHERE id = ?"
      ).run(Math.round(distance * 100) / 100, Math.round(minutes * 10) / 10, order.id);
      order = db.prepare("SELECT * FROM orders WHERE id = ?").get(order.id);
    }

    // Emit to admins
    io.to("admins").emit("order:new", order);
    notifyAdmins(io, "order_new", order);

    res.status(201).json(order);
  });

  // ─── PUT /api/orders/:id ───────────────────────────────────────────────────

  router.put("/:id", requireAuth, requireRole("admin"), (req, res) => {
    const existing = db.prepare("SELECT * FROM orders WHERE id = ?").get(req.params.id);
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

    // Validate and format Colombian phone number if provided
    let formattedPhone = null;
    if (customer_phone && String(customer_phone).trim()) {
      formattedPhone = formatColombianPhone(customer_phone);
      if (!formattedPhone) {
        return res.status(400).json({ error: "Numero de telefono invalido. Debe ser un numero colombiano valido (ej: 3001234567 o +573001234567)" });
      }
    }

    db.prepare(
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
       WHERE id = ?`
    ).run(
      customer_name || null,
      formattedPhone,
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
      req.params.id
    );

    const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(req.params.id);
    res.json(order);
  });

  // ─── POST /api/orders/:id/assign ───────────────────────────────────────────

  router.post("/:id/assign", requireAuth, requireRole("admin"), (req, res) => {
    const { driver_id } = req.body || {};
    if (!driver_id) return res.status(400).json({ error: "driver_id es obligatorio" });

    const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(req.params.id);
    if (!order) return res.status(404).json({ error: "Orden no encontrada" });

    // Verify driver exists
    const driver = db.prepare("SELECT user_id FROM drivers WHERE user_id = ?").get(driver_id);
    if (!driver) return res.status(404).json({ error: "Conductor no encontrado" });

    db.prepare(
      `UPDATE orders SET driver_id = ?, status = 'assigned', assigned_at = datetime('now') WHERE id = ?`
    ).run(driver_id, req.params.id);

    const updated = db.prepare("SELECT * FROM orders WHERE id = ?").get(req.params.id);

    // Notify admins and the assigned driver
    io.to("admins").emit("order:assigned", updated);
    io.to(`driver:${driver_id}`).emit("order:assigned", updated);
    notifyDriver(io, driver_id, "order_assigned", updated);

    // Emit to tracking room
    io.to(`tracking:${updated.code}`).emit("order:assigned", updated);

    // Notify restaurant if linked
    if (updated.restaurant_id) {
      io.to(`restaurant:${updated.restaurant_id}`).emit("order:assigned", updated);
    }

    res.json(updated);
  });

  // ─── POST /api/orders/:id/status ───────────────────────────────────────────

  router.post("/:id/status", requireAuth, (req, res) => {
    const { status } = req.body || {};
    const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(req.params.id);
    if (!order) return res.status(404).json({ error: "Orden no encontrada" });

    // Drivers can only update their own orders
    if (req.user.role === "driver" && order.driver_id !== req.user.id) {
      return res.status(403).json({ error: "No autorizado para esta orden" });
    }

    // Driver workflow: ready_for_pickup/assigned → picked_up → on_the_way → delivered
    const workflow = {
      ready_for_pickup: "picked_up",
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
      db.prepare(
        `UPDATE orders SET status = ?, delivered_at = datetime('now') WHERE id = ?`
      ).run(status, req.params.id);
    } else {
      db.prepare("UPDATE orders SET status = ? WHERE id = ?").run(status, req.params.id);
    }

    const updated = db.prepare("SELECT * FROM orders WHERE id = ?").get(req.params.id);

    // Notify admins
    io.to("admins").emit("order:status", updated);

    // Emit to tracking room
    io.to(`tracking:${updated.code}`).emit("order:status", updated);

    // Notify restaurant if linked
    if (updated.restaurant_id) {
      io.to(`restaurant:${updated.restaurant_id}`).emit("order:status", updated);
    }

    // Additional notifications for delivered status
    if (status === "delivered") {
      notifyAdmins(io, "order_delivered", updated);
    }

    // Notify when picked up (restaurant knows it was collected)
    if (status === "picked_up" && updated.restaurant_id) {
      io.to(`restaurant:${updated.restaurant_id}`).emit("order:picked_up", updated);
    }

    res.json(updated);
  });

  // ─── DELETE /api/orders/:id ────────────────────────────────────────────────

  router.delete("/:id", requireAuth, requireRole("admin"), (req, res) => {
    const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(req.params.id);
    if (!order) return res.status(404).json({ error: "Orden no encontrada" });

    db.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").run(req.params.id);

    const updated = db.prepare("SELECT * FROM orders WHERE id = ?").get(req.params.id);
    io.to("admins").emit("order:status", updated);

    res.json(updated);
  });

  return router;
}
