import { Router } from "express";
import bcrypt from "bcryptjs";
import db from "../db/database.js";
import { requireAuth, requireRole } from "./auth.js";
import { formatColombianPhone } from "./utils.js";

const router = Router();

/** Returns drivers joined with their user info. */
function listDrivers() {
  return db
    .prepare(
      `SELECT u.id, u.name, u.email,
              d.phone, d.vehicle, d.plate, d.status,
              d.lat, d.lng, d.speed, d.last_seen
       FROM users u
       JOIN drivers d ON d.user_id = u.id
       WHERE u.role = 'driver'
       ORDER BY u.name`
    )
    .all();
}

// GET /api/drivers  (admin only) — list all drivers with status & location
router.get("/", requireAuth, requireRole("admin"), (req, res) => {
  res.json(listDrivers());
});

// GET /api/drivers/my-stats — driver's own stats
router.get("/my-stats", requireAuth, (req, res) => {
  if (req.user.role !== "driver") {
    return res.status(403).json({ error: "Solo para repartidores" });
  }

  const driverId = req.user.id;
  const today = new Date().toISOString().slice(0, 10);

  const deliveriesToday = db
    .prepare("SELECT COUNT(*) as count FROM orders WHERE driver_id = ? AND status = 'delivered' AND date(delivered_at) = ?")
    .get(driverId, today).count;

  const earningsToday = db
    .prepare("SELECT COALESCE(SUM(amount), 0) as total FROM orders WHERE driver_id = ? AND status = 'delivered' AND date(delivered_at) = ?")
    .get(driverId, today).total;

  const deliveriesWeek = db
    .prepare("SELECT COUNT(*) as count FROM orders WHERE driver_id = ? AND status = 'delivered' AND delivered_at >= date('now', '-7 days')")
    .get(driverId).count;

  const earningsWeek = db
    .prepare("SELECT COALESCE(SUM(amount), 0) as total FROM orders WHERE driver_id = ? AND status = 'delivered' AND delivered_at >= date('now', '-7 days')")
    .get(driverId).total;

  const totalDeliveries = db
    .prepare("SELECT COUNT(*) as count FROM orders WHERE driver_id = ? AND status = 'delivered'")
    .get(driverId).count;

  const activeOrders = db
    .prepare("SELECT COUNT(*) as count FROM orders WHERE driver_id = ? AND status IN ('assigned', 'picked_up', 'on_the_way')")
    .get(driverId).count;

  const avgDeliveryMinutes = db
    .prepare(
      `SELECT AVG((julianday(delivered_at) - julianday(assigned_at)) * 24 * 60) as avg_minutes
       FROM orders WHERE driver_id = ? AND status = 'delivered' AND delivered_at IS NOT NULL AND assigned_at IS NOT NULL`
    )
    .get(driverId).avg_minutes;

  res.json({
    today: {
      deliveries: deliveriesToday,
      earnings: earningsToday,
    },
    week: {
      deliveries: deliveriesWeek,
      earnings: earningsWeek,
    },
    total_deliveries: totalDeliveries,
    active_orders: activeOrders,
    avg_delivery_minutes: avgDeliveryMinutes ? Math.round(avgDeliveryMinutes) : null,
  });
});

// POST /api/drivers  (admin only) — create a new driver
router.post("/", requireAuth, requireRole("admin"), (req, res) => {
  const { name, email, password, phone, vehicle, plate } = req.body || {};
  if (!name || !email || !password) {
    return res.status(400).json({ error: "Nombre, email y contraseña son obligatorios" });
  }

  // Validate and format Colombian phone number if provided
  let formattedPhone = null;
  if (phone && String(phone).trim()) {
    formattedPhone = formatColombianPhone(phone);
    if (!formattedPhone) {
      return res.status(400).json({ error: "Numero de telefono invalido. Debe ser un numero colombiano valido (ej: 3001234567 o +573001234567)" });
    }
  }

  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(String(email).toLowerCase().trim());
  if (existing) return res.status(409).json({ error: "Ya existe un usuario con ese email" });

  const tx = db.transaction(() => {
    const info = db
      .prepare("INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, 'driver')")
      .run(name.trim(), String(email).toLowerCase().trim(), bcrypt.hashSync(password, 10));
    db.prepare(
      "INSERT INTO drivers (user_id, phone, vehicle, plate, status) VALUES (?, ?, ?, ?, 'offline')"
    ).run(info.lastInsertRowid, formattedPhone, vehicle || null, plate || null);
    return info.lastInsertRowid;
  });

  const id = tx();
  res.status(201).json({ id, name, email, role: "driver", phone: formattedPhone, vehicle, plate, status: "offline" });
});

export { listDrivers };
export default router;
