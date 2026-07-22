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

  /**
   * Tarifa fija de domicilio por horario (zona horaria Colombia UTC-5):
   * - $3000 hasta las 9:00 PM (21:00)
   * - $4000 después de las 9:00 PM
   */
  function getDeliveryFare() {
    const now = new Date();
    // Colombia es UTC-5
    const colombiaHour = new Date(now.toLocaleString("en-US", { timeZone: "America/Bogota" })).getHours();
    return colombiaHour >= 21 ? 4000 : 3000;
  }

  /**
   * Normalizes a Colombian phone number to +57XXXXXXXXXX format.
   * Accepts: "300 123 4567", "3001234567", "+573001234567", "573001234567", "03001234567"
   * Returns: "+573001234567" or null if empty/invalid.
   */
  function normalizePhone(raw) {
    if (!raw) return null;
    let digits = String(raw).replace(/[^\d]/g, '');
    if (!digits) return null;
    // Remove country code 57 if present (12 digits: 57 + 10)
    if (digits.length === 12 && digits.startsWith('57')) digits = digits.slice(2);
    // Remove leading 0 (11 digits: 0 + 10)
    if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
    // Valid Colombian number: 10 digits
    if (digits.length !== 10) return '+57' + digits; // best effort
    return '+57' + digits;
  }

  const STATUS_LABELS = {
    pending: "Pendiente", assigned: "Asignado", picked_up: "Recogido",
    on_the_way: "En camino", delivered: "Entregado", cancelled: "Cancelado",
  };
  const statusLabel = (s) => STATUS_LABELS[s] || s;

  // Notify the originating restaurant (socket + push) about an order change
  function notifyRestaurant(order, event, pushTitle, pushBody) {
    if (!order || !order.restaurant_id) return;
    io.to(`restaurant:${order.restaurant_id}`).emit(event, order);
    sendPush(order.restaurant_id, { title: pushTitle, body: pushBody, url: "/restaurant.html" });
  }

  // date(col) = ?  vs  col::date = ?::date
  const dateEq = (col) => (db.isPostgres ? `${col}::date = ?::date` : `date(${col}) = ?`);

  // ─── GET /api/orders ───────────────────────────────────────────────────────

  router.get("/", requireAuth, async (req, res) => {
    const { role, id: userId } = req.user;

    if (role === "admin") {
      const { status, driver_id } = req.query;

      // Filter by driver_id (for history view)
      if (driver_id) {
        const orders = await db.all(
          "SELECT * FROM orders WHERE driver_id = ? ORDER BY created_at DESC LIMIT 200",
          [parseInt(driver_id, 10)]
        );
        return res.json({ orders });
      }

      if (status) {
        const orders = await db.all(
          "SELECT * FROM orders WHERE status = ? AND archived = 0 ORDER BY created_at DESC",
          [status]
        );
        return res.json(orders);
      }
      const orders = await db.all("SELECT * FROM orders WHERE archived = 0 ORDER BY created_at DESC");
      return res.json(orders);
    }

    // Driver sees only their assigned orders
    if (role === "driver") {
      const orders = await db.all(
        "SELECT * FROM orders WHERE driver_id = ? ORDER BY created_at DESC",
        [userId]
      );
      return res.json(orders);
    }

    // Restaurant sees only the orders it sent
    const orders = await db.all(
      "SELECT * FROM orders WHERE restaurant_id = ? ORDER BY created_at DESC",
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

  router.post("/", requireAuth, async (req, res) => {
    if (req.user.role !== "admin" && req.user.role !== "restaurant") {
      return res.status(403).json({ error: "No autorizado" });
    }
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
      scheduled_at,
      branch_id,
    } = req.body || {};

    // Pickup: restaurants always pick up from their own registered location
    let pickup_address = req.body.pickup_address;
    let pickup_lat = req.body.pickup_lat;
    let pickup_lng = req.body.pickup_lng;
    let restaurant_id = null;
    if (req.user.role === "restaurant") {
      const prof = await db.get(
        "SELECT u.name, r.address, r.lat, r.lng FROM users u JOIN restaurants r ON r.user_id = u.id WHERE u.id = ?",
        [req.user.id]
      );
      restaurant_id = req.user.id;
      pickup_address = (prof && (prof.address || prof.name)) || pickup_address;
      pickup_lat = prof ? prof.lat : pickup_lat;
      pickup_lng = prof ? prof.lng : pickup_lng;
    }

    if (!customer_name) {
      return res.status(400).json({ error: "El nombre del cliente es obligatorio" });
    }

    // Normalize phone to +57 format
    const normalizedPhone = normalizePhone(customer_phone);

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
            normalizedPhone,
            pickup_address || "",
            pickup_lat || null,
            pickup_lng || null,
            dropoff_address || "",
            dropoff_lat || null,
            dropoff_lng || null,
            items || null,
            notes || null,
            amount || getDeliveryFare(),
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

    // Restaurant source (the order was sent by a restaurant)
    if (restaurant_id) {
      await db.run("UPDATE orders SET restaurant_id = ? WHERE id = ?", [restaurant_id, order.id]);
      order = await db.get("SELECT * FROM orders WHERE id = ?", [order.id]);
    }

    // Emit to admins
    io.to("admins").emit("order:new", order);
    notifyAdmins(io, "order_new", order);
    logActivity(req.user, "order_created", "Pedido " + order.code + " creado");

    // Emit to ALL online drivers so they can compete to accept it
    io.to("drivers").emit("order:available", order);

    // Push to all admins
    db.all("SELECT id FROM users WHERE role = 'admin'").then((admins) => {
      admins.forEach((a) => sendPush(a.id, { title: "Nuevo pedido", body: order.code + " - " + order.customer_name, url: "/" }));
    }).catch(() => {});

    // Push to all online drivers
    db.all("SELECT user_id as id FROM drivers WHERE status = 'available'").then((onlineDrivers) => {
      onlineDrivers.forEach((d) => sendPush(d.id, { title: "Nuevo pedido disponible!", body: order.code + " - " + (order.dropoff_address || "Aceptar para ver detalles"), url: "/driver.html" }));
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
    sendPush(driver_id, { title: "Nuevo pedido asignado", body: updated.code + " - " + (updated.dropoff_address || "Sin direccion"), url: "/driver.html" });
    notifyRestaurant(updated, "order:assigned", "Tu pedido fue asignado", updated.code + ": un repartidor va en camino");

    // Auto WhatsApp to customer (only if Twilio is configured)
    if (updated.customer_phone) {
      const base = process.env.PUBLIC_URL || `${req.protocol}://${req.get("host")}`;
      const link = `${base}/customer.html?code=${encodeURIComponent(updated.code)}`;
      sendWhatsApp(updated.customer_phone, `🚨 ¡NUEVA ACTUALIZACIÓN EN SERVICIOS GHOST! 🚨\n\n¡En Servicios Ghost no nos detenemos y seguimos evolucionando para ti! 👻🚀 Queremos contarte que hemos activado un nuevo sistema de seguimiento de pedidos.\n\nA partir de ahora, tendrás el control total de tus entregas:\n✅ Mayor tranquilidad: Sabrás exactamente el estado de tu domicilio.\n✅ Máxima seguridad: Todo monitoreado directamente por nuestra central logística.\n✅ Rapidez garantizada: Rompemos las barreras del tiempo con tecnología premium. ⏱️⚡\n\n🔗 Sigue tu pedido *${updated.code}* en tiempo real aquí:\n${link}\n\n¿Tienes un antojo o necesitas despachar en tu negocio? ¡Pruébalo ya mismo! Tu entrega está en las mejores manos. ⭐⭐⭐⭐⭐\n\n📲 Guarda nuestro contacto y pide al instante: 321 428 6626 📞`);
    }

    res.json(updated);
  });

  // ─── POST /api/orders/:id/accept ───────────────────────────────────────────
  // Driver accepts an available (pending) order — first come, first served.
  // Uses an atomic "compare-and-swap" UPDATE to handle race conditions safely.

  router.post("/:id/accept", requireAuth, async (req, res) => {
    if (req.user.role !== "driver") {
      return res.status(403).json({ error: "Solo repartidores pueden aceptar pedidos" });
    }

    const order = await db.get("SELECT * FROM orders WHERE id = ?", [req.params.id]);
    if (!order) return res.status(404).json({ error: "Orden no encontrada" });

    // Only pending orders can be accepted
    if (order.status !== "pending") {
      return res.status(409).json({
        error: "Este pedido ya fue tomado por otro repartidor",
        current_status: order.status,
      });
    }

    // Atomic update: only succeeds if status is still 'pending' (race-condition safe)
    const result = await db.run(
      `UPDATE orders SET driver_id = ?, status = 'assigned', assigned_at = datetime('now')
       WHERE id = ? AND status = 'pending'`,
      [req.user.id, req.params.id]
    );

    // If no rows were changed, another driver already took it
    if (result.changes === 0) {
      return res.status(409).json({
        error: "Este pedido ya fue tomado por otro repartidor",
      });
    }

    const updated = await db.get("SELECT * FROM orders WHERE id = ?", [req.params.id]);

    // Notify admins that the order was accepted
    io.to("admins").emit("order:assigned", updated);
    io.to("admins").emit("order:accepted", {
      order: updated,
      driver_name: req.user.name,
    });

    // Notify the driver who accepted
    io.to(`driver:${req.user.id}`).emit("order:assigned", updated);

    // Notify ALL drivers that this order is no longer available
    io.to("drivers").emit("order:taken", {
      order_id: updated.id,
      code: updated.code,
      driver_name: req.user.name,
    });

    // Emit to tracking room
    io.to(`tracking:${updated.code}`).emit("order:assigned", updated);

    logActivity(req.user, "order_accepted", "Pedido " + updated.code + " aceptado por " + req.user.name);
    sendPush(req.user.id, { title: "Pedido aceptado!", body: updated.code + " es tuyo", url: "/driver.html" });
    notifyAdmins(io, "order_accepted", { ...updated, accepted_by: req.user.name });
    notifyRestaurant(updated, "order:assigned", "Pedido aceptado", updated.code + " fue aceptado por " + req.user.name);

    // WhatsApp to customer
    if (updated.customer_phone) {
      const base = process.env.PUBLIC_URL || `${req.protocol}://${req.get("host")}`;
      const link = `${base}/customer.html?code=${encodeURIComponent(updated.code)}`;
      sendWhatsApp(updated.customer_phone, `🚨 ¡NUEVA ACTUALIZACIÓN EN SERVICIOS GHOST! 🚨\n\n¡En Servicios Ghost no nos detenemos y seguimos evolucionando para ti! 👻🚀 Queremos contarte que hemos activado un nuevo sistema de seguimiento de pedidos.\n\nA partir de ahora, tendrás el control total de tus entregas:\n✅ Mayor tranquilidad: Sabrás exactamente el estado de tu domicilio.\n✅ Máxima seguridad: Todo monitoreado directamente por nuestra central logística.\n✅ Rapidez garantizada: Rompemos las barreras del tiempo con tecnología premium. ⏱️⚡\n\n🔗 Sigue tu pedido *${updated.code}* en tiempo real aquí:\n${link}\n\n¿Tienes un antojo o necesitas despachar en tu negocio? ¡Pruébalo ya mismo! Tu entrega está en las mejores manos. ⭐⭐⭐⭐⭐\n\n📲 Guarda nuestro contacto y pide al instante: 321 428 6626 📞`);
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
    sendPush(chosen.id, { title: "Nuevo pedido asignado", body: updated.code + " - " + (updated.dropoff_address || "Sin direccion"), url: "/driver.html" });
    notifyRestaurant(updated, "order:assigned", "Tu pedido fue asignado", updated.code + " asignado a " + chosen.name);

    if (updated.customer_phone) {
      const base = process.env.PUBLIC_URL || `${req.protocol}://${req.get("host")}`;
      const link = `${base}/customer.html?code=${encodeURIComponent(updated.code)}`;
      sendWhatsApp(updated.customer_phone, `🚨 ¡NUEVA ACTUALIZACIÓN EN SERVICIOS GHOST! 🚨\n\n¡En Servicios Ghost no nos detenemos y seguimos evolucionando para ti! 👻🚀 Queremos contarte que hemos activado un nuevo sistema de seguimiento de pedidos.\n\nA partir de ahora, tendrás el control total de tus entregas:\n✅ Mayor tranquilidad: Sabrás exactamente el estado de tu domicilio.\n✅ Máxima seguridad: Todo monitoreado directamente por nuestra central logística.\n✅ Rapidez garantizada: Rompemos las barreras del tiempo con tecnología premium. ⏱️⚡\n\n🔗 Sigue tu pedido *${updated.code}* en tiempo real aquí:\n${link}\n\n¿Tienes un antojo o necesitas despachar en tu negocio? ¡Pruébalo ya mismo! Tu entrega está en las mejores manos. ⭐⭐⭐⭐⭐\n\n📲 Guarda nuestro contacto y pide al instante: 321 428 6626 📞`);
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
    notifyRestaurant(updated, "order:status", "Pedido " + updated.code, "Estado: " + statusLabel(status));

    res.json(updated);
  });

  // ─── POST /api/orders/auto-clean ── archive old delivered/cancelled orders ──
  // Marks delivered/cancelled orders from previous days as archived (not deleted)
  router.post("/auto-clean", requireAuth, requireRole("admin"), async (req, res) => {
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const result = await db.run(
      `UPDATE orders SET archived = 1 WHERE status IN ('delivered', 'cancelled') AND date(created_at) < date(?) AND archived = 0`,
      [today]
    );
    const archived = result.changes || 0;
    if (archived > 0) {
      logActivity(req.user, "auto_archive", `Archivados automaticamente: ${archived} pedidos de dias anteriores`);
    }
    res.json({ ok: true, archived: archived });
  });

  // ─── POST /api/orders/clear-selected ── delete specific orders by IDs ───────
  router.post("/clear-selected", requireAuth, requireRole("admin"), async (req, res) => {
    const { ids } = req.body || {};
    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: "Selecciona al menos un pedido" });
    }
    let deleted = 0;
    for (const id of ids) {
      await db.run("DELETE FROM location_history WHERE order_id = ?", [id]);
      await db.run("DELETE FROM order_proofs WHERE order_id = ?", [id]);
      const r = await db.run("DELETE FROM orders WHERE id = ?", [id]);
      if (r.changes) deleted++;
    }
    logActivity(req.user, "orders_deleted", `Eliminados manualmente: ${deleted} pedidos seleccionados`);
    io.to("admins").emit("orders:cleared", { which: "selected", deleted });
    res.json({ ok: true, deleted });
  });

  // ─── POST /api/orders/clear ── delete orders permanently (admin) ───────────
  // body: { which: 'delivered' | 'cancelled' | 'all' }
  router.post("/clear", requireAuth, requireRole("admin"), async (req, res) => {
    const which = (req.body && req.body.which) || "all";
    let cond = "";
    if (which === "delivered") cond = "WHERE status = 'delivered'";
    else if (which === "cancelled") cond = "WHERE status = 'cancelled'";
    else if (which === "old") {
      const today = new Date().toISOString().slice(0, 10);
      cond = "WHERE date(created_at) < date('" + today + "')";
    }
    // 'all' -> no condition

    const rows = await db.all(`SELECT id FROM orders ${cond}`);
    for (const r of rows) {
      await db.run("DELETE FROM location_history WHERE order_id = ?", [r.id]);
      await db.run("DELETE FROM order_proofs WHERE order_id = ?", [r.id]);
    }
    await db.run(`DELETE FROM orders ${cond}`);

    logActivity(req.user, "orders_cleared", `Limpieza de pedidos (${which}): ${rows.length}`);
    io.to("admins").emit("orders:cleared", { which, deleted: rows.length });
    res.json({ ok: true, deleted: rows.length });
  });

  // ─── DELETE /api/orders/:id ────────────────────────────────────────────────

  router.delete("/:id", requireAuth, requireRole("admin"), async (req, res) => {
    const order = await db.get("SELECT * FROM orders WHERE id = ?", [req.params.id]);
    if (!order) return res.status(404).json({ error: "Orden no encontrada" });

    await db.run("UPDATE orders SET status = 'cancelled' WHERE id = ?", [req.params.id]);

    const updated = await db.get("SELECT * FROM orders WHERE id = ?", [req.params.id]);
    io.to("admins").emit("order:status", updated);

    logActivity(req.user, "order_cancelled", "Pedido " + updated.code + " cancelado");
    notifyRestaurant(updated, "order:status", "Pedido " + updated.code, "Tu pedido fue cancelado");

    res.json(updated);
  });

  return router;
}
