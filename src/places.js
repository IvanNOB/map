import { Router } from "express";
import db from "../db/database.js";
import { requireAuth, requireRole } from "./auth.js";
import { logActivity } from "./activity.js";

const router = Router();

// GET /api/places - list points of interest (any authenticated user)
router.get("/", requireAuth, async (req, res) => {
  const rows = await db.all(
    "SELECT id, name, category, address, phone, image, lat, lng FROM places ORDER BY name"
  );
  res.json(rows);
});

// POST /api/places - create a point of interest (admin)
router.post("/", requireAuth, requireRole("admin"), async (req, res) => {
  const { name, category, address, phone, image, lat, lng } = req.body || {};
  if (!name || typeof lat !== "number" || typeof lng !== "number") {
    return res.status(400).json({ error: "name, lat y lng son obligatorios" });
  }
  const cat = category || "otro";
  const info = await db.run(
    "INSERT INTO places (name, category, address, phone, image, lat, lng) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [name.trim(), cat, address || null, phone || null, image || null, lat, lng]
  );
  logActivity(req.user, "place_created", "Lugar: " + name + " (" + cat + ")");
  res.status(201).json({ id: info.lastInsertRowid, name, category: cat, address, phone, image, lat, lng });
});

// PUT /api/places/:id - update a point of interest (admin)
router.put("/:id", requireAuth, requireRole("admin"), async (req, res) => {
  const { name, category, address, phone, image, lat, lng } = req.body || {};
  const place = await db.get("SELECT id FROM places WHERE id = ?", [req.params.id]);
  if (!place) return res.status(404).json({ error: "Lugar no encontrado" });

  await db.run(
    `UPDATE places SET
       name = COALESCE(?, name),
       category = COALESCE(?, category),
       address = ?,
       phone = ?,
       image = COALESCE(?, image),
       lat = COALESCE(?, lat),
       lng = COALESCE(?, lng)
     WHERE id = ?`,
    [
      name ? name.trim() : null,
      category || null,
      address || null,
      phone || null,
      image || null,
      typeof lat === "number" ? lat : null,
      typeof lng === "number" ? lng : null,
      req.params.id,
    ]
  );
  logActivity(req.user, "place_updated", "Lugar actualizado #" + req.params.id);
  const updated = await db.get("SELECT id, name, category, address, phone, image, lat, lng FROM places WHERE id = ?", [req.params.id]);
  res.json(updated);
});

// DELETE /api/places/:id (admin)
router.delete("/:id", requireAuth, requireRole("admin"), async (req, res) => {
  await db.run("DELETE FROM places WHERE id = ?", [req.params.id]);
  logActivity(req.user, "place_deleted", "Lugar eliminado #" + req.params.id);
  res.json({ ok: true });
});

export default router;
