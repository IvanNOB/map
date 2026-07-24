/**
 * Ghosty — WhatsApp Cloud API Connector
 *
 * Handles:
 * 1. Webhook verification (GET) — Meta sends a challenge to confirm your endpoint.
 * 2. Incoming messages (POST) — Receives messages from customers via Meta webhook.
 * 3. Sending replies — Sends text messages back to customers via Graph API.
 *
 * Flow:
 *   Customer WhatsApp → Meta → webhook POST → Ghosty Brain → reply → Graph API → Customer
 */

import { Router } from "express";
import { createHmac } from "crypto";
import config from "../config/index.js";
import logger from "../config/logger.js";
import { processMessage } from "./brain.js";
import { findOrCreateClient, recordOrder } from "./client-memory.js";

const router = Router();

const GRAPH_API_VERSION = "v21.0";
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

// ─── Webhook Verification (GET) ──────────────────────────────────────────────
// Meta sends this when you configure the webhook in the App Dashboard.
// It expects you to echo back the hub.challenge if the verify_token matches.

router.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === config.metaWhatsappVerifyToken) {
    logger.info("WhatsApp webhook verified successfully");
    return res.status(200).send(challenge);
  }

  logger.warn("WhatsApp webhook verification failed", { mode, tokenMatch: token === config.metaWhatsappVerifyToken });
  return res.sendStatus(403);
});

// ─── Incoming Messages (POST) ─────────────────────────────────────────────────
// Meta sends message notifications here. We must always respond 200 quickly.

router.post("/webhook", async (req, res) => {
  // Always acknowledge immediately (Meta requires 200 within 20s)
  res.sendStatus(200);

  if (!config.ghostyEnabled) return;

  try {
    // Validate signature if app secret is configured
    if (config.metaWhatsappAppSecret && !verifySignature(req)) {
      logger.warn("WhatsApp webhook invalid signature");
      return;
    }

    const body = req.body;
    if (!body?.object || body.object !== "whatsapp_business_account") return;

    const entries = body.entry || [];
    for (const entry of entries) {
      const changes = entry.changes || [];
      for (const change of changes) {
        if (change.field !== "messages") continue;
        const value = change.value || {};
        const messages = value.messages || [];
        const contacts = value.contacts || [];

        for (const message of messages) {
          await handleIncomingMessage(message, contacts, value.metadata);
        }
      }
    }
  } catch (error) {
    logger.error("WhatsApp webhook processing error", { error: error?.message });
  }
});

// ─── Message Handler ──────────────────────────────────────────────────────────

async function handleIncomingMessage(message, contacts, metadata) {
  // Only handle text messages for now
  if (message.type !== "text") {
    // For non-text (images, audio, etc.) send a polite fallback
    const phone = message.from;
    await sendTextMessage(phone, "Hola 👻 Por ahora solo puedo leer mensajes de texto. Escríbeme qué necesitas y te ayudo con tu domicilio.");
    return;
  }

  const phone = message.from; // Format: "573214286626"
  const text = message.text?.body?.trim();
  if (!phone || !text) return;

  // Get sender name from contacts array
  const contact = contacts.find((c) => c.wa_id === phone);
  const senderName = contact?.profile?.name || "";

  // Mark message as read
  await markAsRead(message.id, metadata?.phone_number_id);

  logger.info("Ghosty received WhatsApp message", {
    from: phone.slice(-4),
    length: text.length,
    name: senderName.slice(0, 20),
  });

  // Ensure client exists in memory
  await findOrCreateClient(phone, senderName);

  // Process with Ghosty Brain
  const result = await processMessage(phone, text, { senderName });

  // Send reply
  if (result.reply) {
    await sendTextMessage(phone, result.reply);
  }

  // If an order was created, emit event for the dispatcher module
  if (result.action === "create_order" && result.orderData) {
    // Record in client memory
    await recordOrder(phone, {
      name: result.orderData.customer_name,
      address: result.orderData.dropoff_address,
    });

    // Emit event via the global event system (picked up by dispatcher-suggest)
    if (globalThis._ghostyOrderCallback) {
      globalThis._ghostyOrderCallback(result.orderData);
    }

    // Confirm to client
    await sendTextMessage(phone, "✅ Tu pedido ha sido registrado. Te avisaremos cuando un repartidor lo recoja. 👻🛵");
  }
}

// ─── Send Message via Graph API ───────────────────────────────────────────────

export async function sendTextMessage(to, text) {
  if (!config.metaWhatsappToken || !config.metaWhatsappPhoneId) {
    logger.warn("Cannot send WhatsApp: Meta credentials not configured");
    return false;
  }

  const url = `${GRAPH_BASE}/${config.metaWhatsappPhoneId}/messages`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.metaWhatsappToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: to,
        type: "text",
        text: { body: text },
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      logger.warn("WhatsApp send failed", {
        status: response.status,
        error: err?.error?.message,
        to: to.slice(-4),
      });
      return false;
    }

    logger.info("WhatsApp message sent", { to: to.slice(-4), length: text.length });
    return true;
  } catch (error) {
    logger.error("WhatsApp send error", { error: error?.message, to: to.slice(-4) });
    return false;
  }
}

// ─── Mark as Read ─────────────────────────────────────────────────────────────

async function markAsRead(messageId, phoneNumberId) {
  const pid = phoneNumberId || config.metaWhatsappPhoneId;
  if (!pid || !config.metaWhatsappToken || !messageId) return;

  try {
    await fetch(`${GRAPH_BASE}/${pid}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.metaWhatsappToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        status: "read",
        message_id: messageId,
      }),
    });
  } catch { /* Best effort */ }
}

// ─── Signature Verification ───────────────────────────────────────────────────

function verifySignature(req) {
  const signature = req.headers["x-hub-signature-256"];
  if (!signature) return false;

  const rawBody = req.rawBody || JSON.stringify(req.body);
  const expected = "sha256=" + createHmac("sha256", config.metaWhatsappAppSecret)
    .update(rawBody)
    .digest("hex");

  return signature === expected;
}

// ─── Status endpoint (admin) ──────────────────────────────────────────────────

router.get("/status", (req, res) => {
  res.json({
    enabled: config.ghostyEnabled,
    phone_id_configured: !!config.metaWhatsappPhoneId,
    token_configured: !!config.metaWhatsappToken,
    verify_token_configured: !!config.metaWhatsappVerifyToken,
  });
});

export default router;
