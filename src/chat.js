import { Router } from "express";
import db from "../db/database.js";
import { requireAuth } from "./auth.js";

const router = Router();

// GET /api/chat/:driverId - message history for a driver's conversation
router.get("/:driverId", requireAuth, async (req, res) => {
  const driverId = parseInt(req.params.driverId, 10);
  if (!driverId) return res.status(400).json({ error: "driverId invalido" });

  // Drivers can only read their own conversation
  if (req.user.role === "driver" && req.user.id !== driverId) {
    return res.status(403).json({ error: "No autorizado" });
  }

  const msgs = await db.all(
    `SELECT id, driver_id, sender_id, sender_role, body, created_at
     FROM messages WHERE driver_id = ? ORDER BY created_at ASC`,
    [driverId]
  );
  res.json(msgs);
});

export default router;
