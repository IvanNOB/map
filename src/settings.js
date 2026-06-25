import { Router } from "express";
import db from "../db/database.js";
import { requireAuth, requireRole } from "./auth.js";

// Default configuration values (used when not set in DB).
export const DEFAULTS = {
  fare_base: 3000, // base fare (COP)
  fare_per_km: 1500, // per-km rate (COP)
  driver_commission_pct: 80, // % of order amount the driver earns
  currency: "$",
  agency_name: "Servicio Ghost",
};

/** Returns a merged map of defaults + stored settings (values coerced to numbers when numeric). */
export async function getSettingsMap() {
  const rows = await db.all("SELECT key, value FROM settings");
  const map = { ...DEFAULTS };
  for (const r of rows) {
    const def = DEFAULTS[r.key];
    map[r.key] = typeof def === "number" ? Number(r.value) : r.value;
  }
  return map;
}

const router = Router();

// GET /api/settings - read configuration
router.get("/", requireAuth, async (req, res) => {
  res.json(await getSettingsMap());
});

// PUT /api/settings - update configuration (admin only)
router.put("/", requireAuth, requireRole("admin"), async (req, res) => {
  const allowed = Object.keys(DEFAULTS);
  const updates = req.body || {};
  for (const key of Object.keys(updates)) {
    if (!allowed.includes(key)) continue;
    const value = String(updates[key]);
    await db.run(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      [key, value]
    );
  }
  res.json(await getSettingsMap());
});

export default router;
