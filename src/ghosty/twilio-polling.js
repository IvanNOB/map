/**
 * Ghosty Lite — Twilio Polling (no webhook needed).
 *
 * Checks for new WhatsApp messages every 5 seconds via Twilio API.
 * Processes them through brain-lite.js and sends replies.
 *
 * This avoids the need to configure a webhook URL in Twilio
 * (which requires account upgrade on trial).
 */

import config from "../config/index.js";
import logger from "../config/logger.js";
import { processMessageLite } from "./brain-lite.js";
import { findOrCreateClient, recordOrder } from "./client-memory.js";
import { sendWhatsApp } from "../whatsapp.js";

const POLL_INTERVAL_MS = 5000; // Check every 5 seconds
const TWILIO_API_BASE = "https://api.twilio.com/2010-04-01/Accounts";

let lastCheckedTime = new Date().toISOString();
let pollingActive = false;
let pollTimer = null;
let _io = null;

/**
 * Start the polling loop. Called once from server.js at startup.
 */
export function startGhostyPolling(io) {
  _io = io;

  if (!config.twilioSid || !config.twilioToken || !process.env.TWILIO_WHATSAPP_FROM) {
    logger.info("Ghosty polling disabled: Twilio credentials not configured");
    return;
  }

  pollingActive = true;
  lastCheckedTime = new Date().toISOString();
  logger.info("Ghosty Lite polling started", { interval_ms: POLL_INTERVAL_MS });

  pollTimer = setInterval(pollMessages, POLL_INTERVAL_MS);
  pollTimer.unref?.();
}

export function stopGhostyPolling() {
  pollingActive = false;
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

// ─── Poll for new messages ────────────────────────────────────────────────────

async function pollMessages() {
  if (!pollingActive) return;

  try {
    const messages = await fetchNewMessages();
    if (!messages || messages.length === 0) return;

    for (const msg of messages) {
      // Only process inbound messages from WhatsApp
      if (msg.direction !== "inbound") continue;
      if (!msg.from || !msg.from.startsWith("whatsapp:")) continue;

      const phone = msg.from.replace("whatsapp:", "");
      const body = (msg.body || "").trim();
      if (!body) continue;

      await handleMessage(phone, body, msg);
    }
  } catch (error) {
    // Silent fail — don't spam logs on network issues
    if (error?.code !== "ECONNRESET") {
      logger.warn("Ghosty polling error", { error: error?.message });
    }
  }
}

// ─── Fetch messages from Twilio API ───────────────────────────────────────────

async function fetchNewMessages() {
  const url = `${TWILIO_API_BASE}/${config.twilioSid}/Messages.json?DateSent>=${encodeURIComponent(lastCheckedTime)}&To=${encodeURIComponent(process.env.TWILIO_WHATSAPP_FROM)}&PageSize=20`;

  const response = await fetch(url, {
    headers: {
      Authorization: "Basic " + Buffer.from(`${config.twilioSid}:${config.twilioToken}`).toString("base64"),
    },
  });

  if (!response.ok) {
    if (response.status === 401) {
      logger.error("Ghosty polling: Twilio auth failed. Check TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN");
      stopGhostyPolling();
    }
    return null;
  }

  const data = await response.json();

  // Update the timestamp for next poll
  lastCheckedTime = new Date().toISOString();

  return data.messages || [];
}

// ─── Process a single message ─────────────────────────────────────────────────

const processedMessages = new Set(); // Prevent duplicate processing
const MAX_PROCESSED = 500;

async function handleMessage(phone, body, rawMsg) {
  // Deduplicate by message SID
  if (processedMessages.has(rawMsg.sid)) return;
  processedMessages.add(rawMsg.sid);

  // Keep the set from growing forever
  if (processedMessages.size > MAX_PROCESSED) {
    const entries = Array.from(processedMessages);
    for (let i = 0; i < 200; i++) processedMessages.delete(entries[i]);
  }

  logger.info("Ghosty Lite processing message", {
    from: phone.slice(-4),
    length: body.length,
  });

  // Ensure client exists in memory
  await findOrCreateClient(phone, "");

  // Process with rule-based brain
  const result = processMessageLite(phone, body, { senderName: "" });

  // Send reply
  if (result.reply) {
    const sent = await sendWhatsApp(phone, result.reply);
    if (!sent) {
      logger.warn("Ghosty Lite: failed to send reply", { to: phone.slice(-4) });
    }
  }

  // If order was created, trigger the dispatcher
  if (result.action === "create_order" && result.orderData) {
    await recordOrder(phone, {
      name: result.orderData.customer_name,
      address: result.orderData.dropoff_address,
    });

    // Create order via global callback (dispatcher-suggest.js)
    if (globalThis._ghostyOrderCallback) {
      globalThis._ghostyOrderCallback(result.orderData);
    }

    // Notify admin panel via Socket.IO
    if (_io) {
      _io.to("admins").emit("ghosty:order-from-whatsapp", {
        customer_name: result.orderData.customer_name,
        phone: phone.slice(-4),
        pickup: result.orderData.pickup_address,
        dropoff: result.orderData.dropoff_address,
        items: result.orderData.items,
      });
    }

    // Confirm to client
    await sendWhatsApp(phone, "🛵 Un repartidor será asignado pronto. ¡Gracias! 👻");
  }
}

export default { startGhostyPolling, stopGhostyPolling };
