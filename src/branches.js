import { Router } from "express";
import db from "../db/database.js";
import { requireAuth, requireRole } from "./auth.js";
import { logActivity } from "./activity.js";

const router = Router();

// GET /api/branches - list branches (any authenticated user)
router.get("/", requireAuth, async (req, res) => {
  const rows = await db.all("SELECT id, name, address, lat, lng FROM branches ORDER BY name");
  res.json(rows);
});

// POST /api/branches - create (admin)
router.post("/", requireAuth, requireRole("admin"), async (req, res) => {
  const { name, address, lat, lng } = req.body || {};
  if (!name) return res.status(400).json({ error: "El nombre es obligatorio" });
  const info = await db.run(
    "INSERT INTO branches (name, address, lat, lng) VALUES (?, ?, ?, ?)",
    [name.trim(), address || null, typeof lat === "number" ? lat : null, typeof lng === "number" ? lng : null]
  );
  logActivity(req.user, "branch_created", "Sucursal: " + name);
  res.status(201).json({ id: info.lastInsertRowid, name, address, lat, lng });
});

// DELETE /api/branches/:id (admin)
router.delete("/:id", requireAuth, requireRole("admin"), async (req, res) => {
  await db.run("UPDATE orders SET branch_id = NULL WHERE branch_id = ?", [req.params.id]);
  await db.run("DELETE FROM branches WHERE id = ?", [req.params.id]);
  logActivity(req.user, "branch_deleted", "Sucursal eliminada #" + req.params.id);
  res.json({ ok: true });
});

export default router;
