import { Router } from "express";
import db from "../db/database.js";
import { requireAuth, requireRole } from "./auth.js";

/**
 * Log an activity entry. Never throws (best-effort auditing).
 * @param {object} user - { id, name, role }
 * @param {string} action - short action key, e.g. "order_created"
 * @param {string} detail - human-readable detail
 */
export async function logActivity(user, action, detail) {
  try {
    await db.run(
      "INSERT INTO activity_log (user_id, user_name, role, action, detail) VALUES (?, ?, ?, ?, ?)",
      [user?.id || null, user?.name || null, user?.role || null, action, detail || null]
    );
  } catch (e) {
    /* ignore logging errors */
  }
}

const router = Router();

// GET /api/activity?limit=100 - recent activity (admin only)
router.get("/", requireAuth, requireRole("admin"), async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 300);
  const rows = await db.all(
    `SELECT id, user_name, role, action, detail, created_at
     FROM activity_log ORDER BY created_at DESC, id DESC LIMIT ${limit}`
  );
  res.json(rows);
});

export default router;
