/**
 * Server-side WhatsApp sending via Twilio (optional).
 *
 * Enabled ONLY when these environment variables are set:
 *   TWILIO_ACCOUNT_SID
 *   TWILIO_AUTH_TOKEN
 *   TWILIO_WHATSAPP_FROM   e.g. "whatsapp:+14155238886"
 *
 * If not configured, sendWhatsApp() is a no-op and returns false, so the app
 * keeps working (the admin UI still offers the manual wa.me link as fallback).
 */

const SID = process.env.TWILIO_ACCOUNT_SID;
const TOKEN = process.env.TWILIO_AUTH_TOKEN;
const FROM = process.env.TWILIO_WHATSAPP_FROM;

export const whatsappEnabled = !!(SID && TOKEN && FROM);

/**
 * @param {string} toPhone - destination phone (digits, optionally with country code)
 * @param {string} body - message text
 * @returns {Promise<boolean>} true if accepted by Twilio
 */
export async function sendWhatsApp(toPhone, body) {
  if (!whatsappEnabled) return false;
  const digits = String(toPhone || "").replace(/[^0-9+]/g, "");
  if (!digits) return false;

  const to = "whatsapp:" + (digits.startsWith("+") ? digits : "+" + digits);
  const url = `https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages.json`;
  const params = new URLSearchParams({ From: FROM, To: to, Body: body });

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from(`${SID}:${TOKEN}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });
    return res.ok;
  } catch (e) {
    console.warn("[whatsapp] error:", e.message);
    return false;
  }
}
