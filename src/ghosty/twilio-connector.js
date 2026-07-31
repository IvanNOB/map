/**
 * Ghosty — Twilio WhatsApp Connector
 *
 * Receives incoming WhatsApp messages via Twilio webhook and
 * processes them through Ghosty Brain. Sends replies via Twilio.
 *
 * Twilio Sandbox sends a POST with form-urlencoded data:
 *   From: "whatsapp:+573214286626"
 *   Body: "Quiero un domicilio"
 *   ProfileName: "Ivan"
 *
 * We must reply with TwiML or send via API.
 */

import { Router } from "express";
import express from "express";
import config from "../config/index.js";
import logger from "../config/logger.js";
import { processMessage } from "./brain.js";
import { findOrCreateClient, recordOrder } from "./client-memory.js";
import { sendWhatsApp } from "../whatsapp.js";

const router = Router();

// Twilio sends form-urlencoded, not JSON
router.use(express.urlencoded({ extended: false }));

// ─── Incoming WhatsApp messages from Twilio ───────────────────────────────────

router.post("/webhook", async (req, res) => {
  // Respond immediately with empty TwiML (Twilio requires a response)
  res.type("text/xml").send("<Response></Response>");

  if (!config.twilioSid || !config.twilioToken) return;

  try {
    const from = req.body?.From || ""; // "whatsapp:+573214286626"
    const body = (req.body?.Body || "").trim();
    const profileName = req.body?.ProfileName || "";

    if (!from || !body) return;

    // Extract phone number (remove "whatsapp:" prefix)
    const phone = from.replace("whatsapp:", "").replace(/[^\d+]/g, "");
    if (!phone || phone.length < 7) return;

    logger.info("Ghosty Twilio received message", {
      from: phone.slice(-4),
      length: body.length,
      name: profileName.slice(0, 20),
    });

    // Ensure client exists in memory
    await findOrCreateClient(phone, profileName);

    // Process with Ghosty Brain
    const result = await processMessage(phone, body, { senderName: profileName });

    // Send reply via Twilio
    if (result.reply) {
      await sendWhatsApp(phone, result.reply);
    }

    // If an order was created, trigger the dispatcher
    if (result.action === "create_order" && result.orderData) {
      // Record in client memory
      await recordOrder(phone, {
        name: result.orderData.customer_name,
        address: result.orderData.dropoff_address,
      });

      // Trigger order creation via global callback
      if (globalThis._ghostyOrderCallback) {
        result.orderData.customer_phone = phone;
        globalThis._ghostyOrderCallback(result.orderData);
      }

      // Confirm to client
      await sendWhatsApp(phone, "✅ Tu pedido ha sido registrado. Te avisaremos cuando un repartidor lo recoja. 👻🛵");
    }
  } catch (error) {
    logger.error("Ghosty Twilio webhook error", { error: error?.message });
  }
});

// ─── Status endpoint ──────────────────────────────────────────────────────────

router.get("/status", (req, res) => {
  res.json({
    enabled: config.whatsappEnabled,
    provider: "twilio",
    sid_configured: !!config.twilioSid,
    token_configured: !!config.twilioToken,
    from_configured: !!process.env.TWILIO_WHATSAPP_FROM,
  });
});

export default router;
