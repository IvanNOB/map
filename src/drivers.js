import { Router } from "express";
import bcrypt from "bcryptjs";
import db from "../db/database.js";
import { requireAuth, requireRole } from "./auth.js";
import { logActivity } from "./activity.js";

const router = Router();

/** Returns drivers joined with their user info + average rating. */
async function listDrivers() {
  return db.all(
    `SELECT u.id, u.name, u.email,
            d.phone, d.vehicle, d.plate, d.status,
            d.lat, d.lng, d.speed, d.last_seen,
            (SELECT ROUND(AVG(rating), 1) FROM orders WHERE driver_id = u.id AND rating IS NOT NULL) AS avg_rating,
            (SELECT COUNT(*) FROM orders WHERE driver_id = u.id AND status = 'delivered') AS deliveries
     FROM users u
     JOIN drivers d ON d.user_id = u.id
     WHERE u.role = 'driver'
     ORDER BY u.name`
  );
}

// GET /api/drivers  (admin only) — list all drivers with status & location
router.get("/", requireAuth, requireRole("admin"), async (req, res) => {
  res.json(await listDrivers());
});

// POST /api/drivers  (admin only) — create a new driver
router.post("/", requireAuth, requireRole("admin"), async (req, res) => {
  const { name, email, password, phone, vehicle, plate } = req.body || {};
  if (!name || !email || !password) {
    return res.status(400).json({ error: "Nombre, email y contraseña son obligatorios" });
  }

  const normalizedEmail = String(email).toLowerCase().trim();
  const existing = await db.get("SELECT id FROM users WHERE email = ?", [normalizedEmail]);
  if (existing) return res.status(409).json({ error: "Ya existe un usuario con ese email" });

  const userResult = await db.run(
    "INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, 'driver')",
    [name.trim(), normalizedEmail, bcrypt.hashSync(password, 10)]
  );
  const id = userResult.lastInsertRowid;

  await db.run(
    "INSERT INTO drivers (user_id, phone, vehicle, plate, status) VALUES (?, ?, ?, ?, 'offline')",
    [id, phone || null, vehicle || null, plate || null]
  );

  logActivity(req.user, "driver_created", "Repartidor creado: " + name);

  res.status(201).json({ id, name, email: normalizedEmail, role: "driver", phone, vehicle, plate, status: "offline" });
});

// PUT /api/drivers/:id  (admin only) — edit a driver (and optional password)
router.put("/:id", requireAuth, requireRole("admin"), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { name, phone, vehicle, plate, password } = req.body || {};

  const user = await db.get("SELECT id, role FROM users WHERE id = ?", [id]);
  if (!user || user.role !== "driver") return res.status(404).json({ error: "Repartidor no encontrado" });

  if (name) await db.run("UPDATE users SET name = ? WHERE id = ?", [name.trim(), id]);
  if (password) await db.run("UPDATE users SET password = ? WHERE id = ?", [bcrypt.hashSync(password, 10), id]);
  await db.run(
    `UPDATE drivers SET
       phone = COALESCE(?, phone),
       vehicle = COALESCE(?, vehicle),
       plate = COALESCE(?, plate)
     WHERE user_id = ?`,
    [phone ?? null, vehicle ?? null, plate ?? null, id]
  );

  logActivity(req.user, "driver_updated", "Repartidor #" + id + " actualizado");
  res.json({ ok: true });
});

// DELETE /api/drivers/:id  (admin only) — delete a driver
router.delete("/:id", requireAuth, requireRole("admin"), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const user = await db.get("SELECT id, role, name FROM users WHERE id = ?", [id]);
  if (!user || user.role !== "driver") return res.status(404).json({ error: "Repartidor no encontrado" });

  // Explicit cleanup (sql.js doesn't enforce FK cascade/set-null)
  await db.run("UPDATE orders SET driver_id = NULL WHERE driver_id = ?", [id]);
  await db.run("DELETE FROM drivers WHERE user_id = ?", [id]);
  await db.run("DELETE FROM push_subscriptions WHERE user_id = ?", [id]);
  await db.run("DELETE FROM messages WHERE driver_id = ?", [id]);
  await db.run("DELETE FROM users WHERE id = ?", [id]);
  logActivity(req.user, "driver_deleted", "Repartidor eliminado: " + user.name);
  res.json({ ok: true });
});

export { listDrivers };
export default router;
