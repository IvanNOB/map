import { Router } from "express";
import db from "../db/database.js";
import { requireAuth } from "./auth.js";
import { haversineDistance, estimateTime, formatColombianPhone } from "./utils.js";
import { notifyAdmins } from "./notifications.js";

/**
 * Restaurant router factory.
 * Receives the Socket.IO `io` instance for real-time events.
 */
export default function createRestaurantRouter(io) {
  const router = Router();

  // ─── Helpers ───────────────────────────────────────────────────────────────

  function generateCode() {
    const ts = Date.now().toString(36).toUpperCase().slice(-4);
    return `ORD-${ts}${Math.random().toString(36).slice(2, 4).toUpperCase()}`;
  }

  /** Middleware: only restaurant role */
  function requireRestaurant(req, res, next) {
    if (req.user.role !== "restaurant") {
      return res.status(403).json({ error: "Solo para restaurantes" });
    }
    next();
  }

  // ─── GET /api/restaurant/profile ───────────────────────────────────────────

  router.get("/profile", requireAuth, requireRestaurant, (req, res) => {
    const restaurant = db.prepare(
      `SELECT u.id, u.name, u.email, r.phone, r.address, r.lat, r.lng, r.category, r.description
       FROM users u
       JOIN restaurants r ON r.user_id = u.id
       WHERE u.id = ?`
    ).get(req.user.id);

    if (!restaurant) {
      return res.status(404).json({ error: "Perfil de restaurante no encontrado" });
    }

    res.json(restaurant);
  });

  // ─── PUT /api/restaurant/profile ───────────────────────────────────────────

  router.put("/profile", requireAuth, requireRestaurant, (req, res) => {
    const { phone, address, lat, lng, category, description } = req.body || {};

    let formattedPhone = null;
    if (phone && String(phone).trim()) {
      formattedPhone = formatColombianPhone(phone);
      if (!formattedPhone) {
        return res.status(400).json({ error: "Numero de telefono invalido" });
      }
    }

    db.prepare(
      `UPDATE restaurants SET
        phone = COALESCE(?, phone),
        address = COALESCE(?, address),
        lat = COALESCE(?, lat),
        lng = COALESCE(?, lng),
        category = COALESCE(?, category),
        description = COALESCE(?, description)
       WHERE user_id = ?`
    ).run(
      formattedPhone,
      address || null,
      lat || null,
      lng || null,
      category || null,
      description || null,
      req.user.id
    );

    res.json({ ok: true });
  });

  // ─── GET /api/restaurant/orders ────────────────────────────────────────────

  router.get("/orders", requireAuth, requireRestaurant, (req, res) => {
    const { status, page = 1, limit = 50 } = req.query;
    const pageNum = Math.max(1, parseInt(page) || 1);
    const limitNum = Math.min(200, Math.max(1, parseInt(limit) || 50));
    const offset = (pageNum - 1) * limitNum;

    let whereClause = "WHERE o.restaurant_id = ?";
    const params = [req.user.id];

    if (status) {
      whereClause += " AND o.status = ?";
      params.push(status);
    }

    const countRow = db
      .prepare(`SELECT COUNT(*) as total FROM orders o ${whereClause}`)
      .get(...params);
    const total = countRow.total;

    const orders = db
      .prepare(
        `SELECT o.*, COALESCE(u.name, '') as driver_name
         FROM orders o
         LEFT JOIN users u ON u.id = o.driver_id
         ${whereClause}
         ORDER BY o.created_at DESC
         LIMIT ? OFFSET ?`
      )
      .all(...params, limitNum, offset);

    res.json({
      orders,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        pages: Math.ceil(total / limitNum),
      },
    });
  });

  // ─── GET /api/restaurant/orders/:id ────────────────────────────────────────

  router.get("/orders/:id", requireAuth, requireRestaurant, (req, res) => {
    const order = db.prepare(
      "SELECT * FROM orders WHERE id = ? AND restaurant_id = ?"
    ).get(req.params.id, req.user.id);

    if (!order) {
      return res.status(404).json({ error: "Orden no encontrada" });
    }

    res.json(order);
  });

  // ─── POST /api/restaurant/orders ───────────────────────────────────────────
  // Restaurant creates a new order (customer called/ordered at the restaurant)

  router.post("/orders", requireAuth, requireRestaurant, (req, res) => {
    const {
      customer_name,
      customer_phone,
      dropoff_address,
      dropoff_lat,
      dropoff_lng,
      items,
      notes,
      amount,
      payment_method,
    } = req.body || {};

    if (!customer_name || !dropoff_address) {
      return res.status(400).json({ error: "customer_name y dropoff_address son obligatorios" });
    }

    // Validate phone
    let formattedPhone = null;
    if (customer_phone && String(customer_phone).trim()) {
      formattedPhone = formatColombianPhone(customer_phone);
      if (!formattedPhone) {
        return res.status(400).json({ error: "Numero de telefono del cliente invalido" });
      }
    }

    // Get restaurant info for pickup address
    const restaurant = db.prepare(
      "SELECT r.address, r.lat, r.lng, u.name FROM restaurants r JOIN users u ON u.id = r.user_id WHERE r.user_id = ?"
    ).get(req.user.id);

    if (!restaurant) {
      return res.status(500).json({ error: "Informacion del restaurante no encontrada" });
    }

    // Generate order code with retry
    const MAX_RETRIES = 5;
    let order = null;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const code = generateCode();
      try {
        const info = db.prepare(
          `INSERT INTO orders (code, customer_name, customer_phone,
                               pickup_address, pickup_lat, pickup_lng,
                               dropoff_address, dropoff_lat, dropoff_lng,
                               items, notes, amount, payment_method,
                               status, restaurant_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
        ).run(
          code,
          customer_name,
          formattedPhone,
          restaurant.address || restaurant.name,
          restaurant.lat || null,
          restaurant.lng || null,
          dropoff_address,
          dropoff_lat || null,
          dropoff_lng || null,
          items || null,
          notes || null,
          amount || 0,
          payment_method || "cash",
          req.user.id
        );
        order = db.prepare("SELECT * FROM orders WHERE id = ?").get(info.lastInsertRowid);
        break;
      } catch (err) {
        if (err.message && (err.message.includes("UNIQUE") || err.message.includes("unique"))) {
          if (attempt === MAX_RETRIES - 1) {
            return res.status(500).json({ error: "No se pudo generar un codigo unico" });
          }
          continue;
        }
        console.error("Error creating restaurant order:", err.message);
        return res.status(500).json({ error: "Error al crear la orden" });
      }
    }

    // Calculate estimated distance/time if coordinates available
    if (restaurant.lat && restaurant.lng && dropoff_lat && dropoff_lng) {
      const distance = haversineDistance(restaurant.lat, restaurant.lng, dropoff_lat, dropoff_lng);
      const minutes = estimateTime(distance);
      db.prepare(
        "UPDATE orders SET estimated_distance_km = ?, estimated_minutes = ? WHERE id = ?"
      ).run(Math.round(distance * 100) / 100, Math.round(minutes * 10) / 10, order.id);
      order = db.prepare("SELECT * FROM orders WHERE id = ?").get(order.id);
    }

    // Notify admins about new order from restaurant
    io.to("admins").emit("order:new", order);
    notifyAdmins(io, "order_new", { ...order, from_restaurant: restaurant.name });

    res.status(201).json(order);
  });

  // ─── POST /api/restaurant/orders/:id/status ────────────────────────────────
  // Restaurant updates order status: pending → confirmed → preparing → ready_for_pickup

  router.post("/orders/:id/status", requireAuth, requireRestaurant, (req, res) => {
    const { status } = req.body || {};
    const order = db.prepare(
      "SELECT * FROM orders WHERE id = ? AND restaurant_id = ?"
    ).get(req.params.id, req.user.id);

    if (!order) {
      return res.status(404).json({ error: "Orden no encontrada" });
    }

    // Restaurant workflow
    const restaurantWorkflow = {
      pending: "confirmed",
      confirmed: "preparing",
      preparing: "ready_for_pickup",
    };

    const nextAllowed = restaurantWorkflow[order.status];
    if (!nextAllowed || nextAllowed !== status) {
      return res.status(400).json({
        error: `Transicion invalida: ${order.status} -> ${status}`,
        allowed: nextAllowed || null,
      });
    }

    // Update status with timestamps
    if (status === "confirmed") {
      db.prepare("UPDATE orders SET status = ?, confirmed_at = datetime('now') WHERE id = ?")
        .run(status, order.id);
    } else if (status === "ready_for_pickup") {
      db.prepare("UPDATE orders SET status = ?, ready_at = datetime('now') WHERE id = ?")
        .run(status, order.id);
    } else {
      db.prepare("UPDATE orders SET status = ? WHERE id = ?").run(status, order.id);
    }

    const updated = db.prepare("SELECT * FROM orders WHERE id = ?").get(order.id);

    // Notify admins
    io.to("admins").emit("order:status", updated);

    // Notify tracking room
    io.to(`tracking:${updated.code}`).emit("order:status", updated);

    // If ready_for_pickup, notify the assigned driver
    if (status === "ready_for_pickup" && updated.driver_id) {
      io.to(`driver:${updated.driver_id}`).emit("order:ready", updated);
      notifyAdmins(io, "order_ready", updated);
    }

    // Notify restaurant room (for their own UI update)
    io.to(`restaurant:${req.user.id}`).emit("order:status", updated);

    res.json(updated);
  });

  // ─── POST /api/restaurant/orders/:id/cancel ────────────────────────────────

  router.post("/orders/:id/cancel", requireAuth, requireRestaurant, (req, res) => {
    const order = db.prepare(
      "SELECT * FROM orders WHERE id = ? AND restaurant_id = ?"
    ).get(req.params.id, req.user.id);

    if (!order) {
      return res.status(404).json({ error: "Orden no encontrada" });
    }

    // Can only cancel if not yet picked up
    if (["picked_up", "on_the_way", "delivered"].includes(order.status)) {
      return res.status(400).json({ error: "No se puede cancelar una orden que ya fue recogida" });
    }

    db.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").run(order.id);

    const updated = db.prepare("SELECT * FROM orders WHERE id = ?").get(order.id);

    io.to("admins").emit("order:status", updated);
    io.to(`tracking:${updated.code}`).emit("order:status", updated);
    io.to(`restaurant:${req.user.id}`).emit("order:status", updated);

    if (updated.driver_id) {
      io.to(`driver:${updated.driver_id}`).emit("order:cancelled", updated);
    }

    res.json(updated);
  });

  // ─── GET /api/restaurant/stats ─────────────────────────────────────────────

  router.get("/stats", requireAuth, requireRestaurant, (req, res) => {
    const restaurantId = req.user.id;
    const today = new Date().toISOString().slice(0, 10);

    const ordersToday = db
      .prepare("SELECT COUNT(*) as count FROM orders WHERE restaurant_id = ? AND date(created_at) = ?")
      .get(restaurantId, today).count;

    const deliveriesToday = db
      .prepare("SELECT COUNT(*) as count FROM orders WHERE restaurant_id = ? AND status = 'delivered' AND date(delivered_at) = ?")
      .get(restaurantId, today).count;

    const revenueToday = db
      .prepare("SELECT COALESCE(SUM(amount), 0) as total FROM orders WHERE restaurant_id = ? AND status = 'delivered' AND date(delivered_at) = ?")
      .get(restaurantId, today).total;

    const activeOrders = db
      .prepare("SELECT COUNT(*) as count FROM orders WHERE restaurant_id = ? AND status IN ('pending', 'confirmed', 'preparing', 'ready_for_pickup', 'assigned', 'picked_up', 'on_the_way')")
      .get(restaurantId).count;

    const pendingOrders = db
      .prepare("SELECT COUNT(*) as count FROM orders WHERE restaurant_id = ? AND status = 'pending'")
      .get(restaurantId).count;

    const preparingOrders = db
      .prepare("SELECT COUNT(*) as count FROM orders WHERE restaurant_id = ? AND status = 'preparing'")
      .get(restaurantId).count;

    const readyOrders = db
      .prepare("SELECT COUNT(*) as count FROM orders WHERE restaurant_id = ? AND status = 'ready_for_pickup'")
      .get(restaurantId).count;

    const ordersWeek = db
      .prepare("SELECT COUNT(*) as count FROM orders WHERE restaurant_id = ? AND created_at >= date('now', '-7 days')")
      .get(restaurantId).count;

    const revenueWeek = db
      .prepare("SELECT COALESCE(SUM(amount), 0) as total FROM orders WHERE restaurant_id = ? AND status = 'delivered' AND delivered_at >= date('now', '-7 days')")
      .get(restaurantId).total;

    const avgPrepMinutes = db
      .prepare(
        `SELECT AVG((julianday(ready_at) - julianday(confirmed_at)) * 24 * 60) as avg_minutes
         FROM orders WHERE restaurant_id = ? AND ready_at IS NOT NULL AND confirmed_at IS NOT NULL`
      )
      .get(restaurantId).avg_minutes;

    res.json({
      today: {
        orders: ordersToday,
        deliveries: deliveriesToday,
        revenue: revenueToday,
      },
      week: {
        orders: ordersWeek,
        revenue: revenueWeek,
      },
      active_orders: activeOrders,
      pending_orders: pendingOrders,
      preparing_orders: preparingOrders,
      ready_orders: readyOrders,
      avg_prep_minutes: avgPrepMinutes ? Math.round(avgPrepMinutes) : null,
    });
  });

  return router;
}
