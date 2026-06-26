import { Router } from "express";
import bcrypt from "bcryptjs";
import db from "../db/database.js";
import { requireAuth, requireRole } from "./auth.js";
import { logActivity } from "./activity.js";

const router = Router();

// GET /api/restaurants - list all restaurants (admin)
router.get("/", requireAuth, requireRole("admin"), async (req, res) => {
  const rows = await db.all(
    `SELECT u.id, u.name, u.email, r.address, r.phone, r.lat, r.lng
     FROM users u JOIN restaurants r ON r.user_id = u.id
     WHERE u.role = 'restaurant' ORDER BY u.name`
  );
  res.json(rows);
});

// GET /api/restaurants/me - own profile (restaurant)
router.get("/me", requireAuth, async (req, res) => {
  if (req.user.role !== "restaurant") return res.status(403).json({ error: "Solo restaurantes" });
  const r = await db.get(
    `SELECT u.id, u.name, u.email, r.address, r.phone, r.lat, r.lng
     FROM users u JOIN restaurants r ON r.user_id = u.id WHERE u.id = ?`,
    [req.user.id]
  );
  res.json(r || {});
});

// POST /api/restaurants - create a restaurant user (admin)
router.post("/", requireAuth, requireRole("admin"), async (req, res) => {
  const { name, email, password, address, phone, lat, lng } = req.body || {};
  if (!name || !email || !password) {
    return res.status(400).json({ error: "Nombre, email y contraseña son obligatorios" });
  }
  const norm = String(email).toLowerCase().trim();
  const existing = await db.get("SELECT id FROM users WHERE email = ?", [norm]);
  if (existing) return res.status(409).json({ error: "Ya existe un usuario con ese email" });

  const info = await db.run(
    "INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, 'restaurant')",
    [name.trim(), norm, bcrypt.hashSync(password, 10)]
  );
  const id = info.lastInsertRowid;
  await db.run(
    "INSERT INTO restaurants (user_id, address, phone, lat, lng) VALUES (?, ?, ?, ?, ?)",
    [id, address || null, phone || null, typeof lat === "number" ? lat : null, typeof lng === "number" ? lng : null]
  );
  logActivity(req.user, "restaurant_created", "Restaurante: " + name);
  res.status(201).json({ id, name, email: norm, address, phone, lat, lng });
});

// PUT /api/restaurants/:id - edit a restaurant (admin)
router.put("/:id", requireAuth, requireRole("admin"), async (req, res) => {
  const { name, address, phone, lat, lng, password } = req.body || {};
  const u = await db.get("SELECT id, role FROM users WHERE id = ?", [req.params.id]);
  if (!u || u.role !== "restaurant") return res.status(404).json({ error: "Restaurante no encontrado" });

  if (name) await db.run("UPDATE users SET name = ? WHERE id = ?", [name.trim(), req.params.id]);
  if (password) await db.run("UPDATE users SET password = ? WHERE id = ?", [bcrypt.hashSync(password, 10), req.params.id]);
  await db.run(
    "UPDATE restaurants SET address = ?, phone = ?, lat = COALESCE(?, lat), lng = COALESCE(?, lng) WHERE user_id = ?",
    [address || null, phone || null, typeof lat === "number" ? lat : null, typeof lng === "number" ? lng : null, req.params.id]
  );
  logActivity(req.user, "restaurant_updated", "Restaurante #" + req.params.id);
  res.json({ ok: true });
});

// DELETE /api/restaurants/:id (admin)
router.delete("/:id", requireAuth, requireRole("admin"), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const u = await db.get("SELECT id, role, name FROM users WHERE id = ?", [id]);
  if (!u || u.role !== "restaurant") return res.status(404).json({ error: "Restaurante no encontrado" });
  await db.run("UPDATE orders SET restaurant_id = NULL WHERE restaurant_id = ?", [id]);
  await db.run("DELETE FROM restaurants WHERE user_id = ?", [id]);
  await db.run("DELETE FROM users WHERE id = ?", [id]);
  logActivity(req.user, "restaurant_deleted", "Restaurante eliminado: " + u.name);
  res.json({ ok: true });
});

export default router;
