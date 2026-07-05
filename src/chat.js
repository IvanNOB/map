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

// POST /api/chat/broadcast - send a message to all drivers (admin only)
router.post("/broadcast", requireAuth, async (req, res) => {
  if (req.user.role !== "admin") {
    return res.status(403).json({ error: "Solo administradores" });
  }
  const { message } = req.body;
  if (!message || !String(message).trim()) {
    return res.status(400).json({ error: "Mensaje requerido" });
  }
  const io = req.app.get("io");
  if (io) {
    io.to("drivers").emit("notification", {
      type: "admin_message",
      data: { title: "Aviso de Central Ghost", body: String(message).trim() },
    });
  }
  res.json({ ok: true, message: "Broadcast enviado" });
});

export default router;
