/**
 * Ghosty — Voice Commands API
 *
 * POST /api/ghosty/voice — Receives transcribed voice commands from the admin panel
 * and processes them through Ghosty Brain.
 */

import { Router } from "express";
import { requireAuth, requireRole } from "../auth.js";
import { processAdminCommand } from "./brain.js";
import logger from "../config/logger.js";

const router = Router();

router.post("/", requireAuth, requireRole("admin"), async (req, res) => {
  const command = (req.body?.command || "").trim();

  if (!command || command.length < 2) {
    return res.status(400).json({ error: "Comando vacío o muy corto" });
  }

  if (command.length > 500) {
    return res.status(400).json({ error: "Comando demasiado largo" });
  }

  logger.info("Ghosty voice command received", {
    admin: req.user.name,
    length: command.length,
  });

  const result = await processAdminCommand(command);

  // If the command results in an order creation, trigger the dispatcher
  if (result.action === "create_order" && result.orderData) {
    result.orderData.customer_phone = result.orderData.customer_phone || "";
    if (globalThis._ghostyOrderCallback) {
      globalThis._ghostyOrderCallback(result.orderData);
    }
  }

  res.json({
    reply: result.reply,
    action: result.action || null,
    orderData: result.orderData || null,
  });
});

export default router;
