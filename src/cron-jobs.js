/**
 * Scheduled tasks / Cron Jobs
 * Extracted from server.js for clarity and modularity.
 */
import db, { isPostgres } from "../db/database.js";
import { sendPush } from "./push.js";
import config from "./config/index.js";
import logger from "./config/logger.js";

/**
 * Start all cron jobs.
 * @param {import("socket.io").Server} io
 */
export function startCronJobs(io) {
  startOfflineDetection(io);
  if (config.alarmEnabled) startMorningAlarm();
  logger.info("Cron jobs started", { offlineCheck: `${config.offlineCheckIntervalMs}ms`, alarm: config.alarmEnabled ? `${config.alarmHour}:${String(config.alarmMinute).padStart(2, "0")}` : "disabled" });
}

// ─── Offline Detection ───────────────────────────────────────────────────────

function startOfflineDetection(io) {
  const OFFLINE_SQL = isPostgres
    ? `SELECT user_id FROM drivers WHERE status != 'offline' AND last_seen < NOW() - INTERVAL '${config.offlineThresholdSeconds} seconds'`
    : `SELECT user_id FROM drivers WHERE status != 'offline' AND last_seen < datetime('now', '-${config.offlineThresholdSeconds} seconds')`;

  setInterval(async () => {
    try {
      const stale = await db.all(OFFLINE_SQL);
      for (const { user_id } of stale) {
        await db.run("UPDATE drivers SET status = 'offline' WHERE user_id = ?", [user_id]);
        io.to("admins").emit("driver:offline", { id: user_id });
      }
    } catch (err) {
      logger.error("Offline detection error", { error: err.message });
    }
  }, config.offlineCheckIntervalMs);
}

// ─── Morning Alarm (8:00 AM Push to all drivers) ─────────────────────────────

function startMorningAlarm() {
  let lastAlarmDate = null;

  setInterval(async () => {
    try {
      const now = new Date();
      const colombiaTime = new Date(now.toLocaleString("en-US", { timeZone: config.timezone }));
      const hour = colombiaTime.getHours();
      const minute = colombiaTime.getMinutes();
      const today = colombiaTime.toISOString().slice(0, 10);

      if (hour === config.alarmHour && minute === config.alarmMinute && lastAlarmDate !== today) {
        lastAlarmDate = today;
        logger.info("Morning alarm triggered — sending push to all drivers");

        const drivers = await db.all("SELECT u.id, u.name FROM users u WHERE u.role = 'driver'");
        let sent = 0;
        for (const driver of drivers) {
          await sendPush(driver.id, {
            title: "🚨 ¡Buenos días! Es hora de trabajar",
            body: "Conéctate ahora para empezar a recibir pedidos. ¡Los clientes te esperan!",
            url: "/driver.html",
            tag: "alarm-morning",
            vibrate: [500, 200, 500, 200, 500],
            requireInteraction: true,
          });
          sent++;
        }
        logger.info(`Morning alarm sent to ${sent} drivers`);
      }
    } catch (err) {
      logger.error("Morning alarm error", { error: err.message });
    }
  }, 60_000);
}
