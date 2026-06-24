import { Router } from "express";
import webpush from "web-push";
import db from "../db/database.js";
import { requireAuth } from "./auth.js";

let publicKey = null;
let enabled = false;

/**
 * Initialize Web Push: load VAPID keys from settings, or generate & persist them.
 * Called once at server startup.
 */
export async function initPush() {
  try {
    let pub = (await db.get("SELECT value FROM settings WHERE key = ?", ["vapid_public"]))?.value;
    let priv = (await db.get("SELECT value FROM settings WHERE key = ?", ["vapid_private"]))?.value;

    if (!pub || !priv) {
      const keys = webpush.generateVAPIDKeys();
      pub = keys.publicKey;
      priv = keys.privateKey;
      await db.run("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", ["vapid_public", pub]);
      await db.run("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", ["vapid_private", priv]);
    }

    const contact = process.env.VAPID_CONTACT || "mailto:admin@agencia.com";
    webpush.setVapidDetails(contact, pub, priv);
    publicKey = pub;
    enabled = true;
  } catch (e) {
    console.warn("[push] No se pudo inicializar Web Push:", e.message);
    enabled = false;
  }
}

export function getPublicKey() {
  return publicKey;
}

/** Send a push notification to all of a user's subscribed devices. */
export async function sendPush(userId, payload) {
  if (!enabled || !userId) return;
  try {
    const subs = await db.all("SELECT endpoint, subscription FROM push_subscriptions WHERE user_id = ?", [userId]);
    const body = JSON.stringify(payload);
    for (const s of subs) {
      try {
        await webpush.sendNotification(JSON.parse(s.subscription), body);
      } catch (err) {
        // Remove dead subscriptions (expired/unsubscribed)
        if (err.statusCode === 404 || err.statusCode === 410) {
          await db.run("DELETE FROM push_subscriptions WHERE endpoint = ?", [s.endpoint]);
        }
      }
    }
  } catch (e) {
    /* ignore */
  }
}

const router = Router();

// GET /api/push/key - VAPID public key for the client to subscribe
router.get("/key", (req, res) => {
  res.json({ key: publicKey, enabled });
});

// POST /api/push/subscribe - store a browser push subscription for the user
router.post("/subscribe", requireAuth, async (req, res) => {
  const sub = req.body && req.body.subscription;
  if (!sub || !sub.endpoint) return res.status(400).json({ error: "Suscripcion invalida" });
  await db.run(
    "INSERT INTO push_subscriptions (endpoint, user_id, subscription) VALUES (?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, subscription = excluded.subscription",
    [sub.endpoint, req.user.id, JSON.stringify(sub)]
  );
  res.json({ ok: true });
});

export default router;
