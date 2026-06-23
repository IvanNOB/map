import { Router } from "express";
import bcrypt from "bcryptjs";
import db from "../db/database.js";
import { requireAuth, requireRole } from "./auth.js";

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

// POST /api/drivers  (admin only) — create a new driver
router.post("/", requireAuth, requireRole("admin"), (req, res) => {
  const { name, email, password, phone, vehicle, plate } = req.body || {};
  if (!name || !email || !password) {
    return res.status(400).json({ error: "Nombre, email y contraseña son obligatorios" });
  }

  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(String(email).toLowerCase().trim());
  if (existing) return res.status(409).json({ error: "Ya existe un usuario con ese email" });

  const tx = db.transaction(() => {
    const info = db
      .prepare("INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, 'driver')")
      .run(name.trim(), String(email).toLowerCase().trim(), bcrypt.hashSync(password, 10));
    db.prepare(
      "INSERT INTO drivers (user_id, phone, vehicle, plate, status) VALUES (?, ?, ?, ?, 'offline')"
    ).run(info.lastInsertRowid, phone || null, vehicle || null, plate || null);
    return info.lastInsertRowid;
  });

  const id = tx();
  res.status(201).json({ id, name, email, role: "driver", phone, vehicle, plate, status: "offline" });
});

export { listDrivers };
export default router;
