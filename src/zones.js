import { Router } from "express";
import db from "../db/database.js";
import { requireAuth, requireRole } from "./auth.js";
import { logActivity } from "./activity.js";

const router = Router();

// GET /api/zones - list coverage zones (any authenticated user)
router.get("/", requireAuth, async (req, res) => {
  const zones = await db.all("SELECT id, name, lat, lng, radius_km FROM zones ORDER BY name");
  res.json(zones);
});

// POST /api/zones - create a coverage zone (admin)
router.post("/", requireAuth, requireRole("admin"), async (req, res) => {
  const { name, lat, lng, radius_km } = req.body || {};
  if (!name || typeof lat !== "number" || typeof lng !== "number" || typeof radius_km !== "number") {
    return res.status(400).json({ error: "name, lat, lng y radius_km son obligatorios" });
  }
  const info = await db.run(
    "INSERT INTO zones (name, lat, lng, radius_km) VALUES (?, ?, ?, ?)",
    [name.trim(), lat, lng, radius_km]
  );
  logActivity(req.user, "zone_created", "Zona de cobertura: " + name);
  res.status(201).json({ id: info.lastInsertRowid, name, lat, lng, radius_km });
});

// DELETE /api/zones/:id - remove a zone (admin)
router.delete("/:id", requireAuth, requireRole("admin"), async (req, res) => {
  await db.run("DELETE FROM zones WHERE id = ?", [req.params.id]);
  logActivity(req.user, "zone_deleted", "Zona eliminada #" + req.params.id);
  res.json({ ok: true });
});

export default router;
