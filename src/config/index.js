/**
 * Centralized application configuration.
 * All environment variables and constants in one place.
 */

export const config = {
  // ─── Server ────────────────────────────────────────────────────────────────
  port: parseInt(process.env.PORT || "3000", 10),
  nodeEnv: process.env.NODE_ENV || "development",
  isProduction: process.env.NODE_ENV === "production",
  publicUrl: process.env.PUBLIC_URL || "",
  corsOrigin: process.env.CORS_ORIGIN || "https://map-rgi5.onrender.com",

  // ─── Database ──────────────────────────────────────────────────────────────
  databaseUrl: process.env.DATABASE_URL || "",
  isPostgres: !!process.env.DATABASE_URL,

  // ─── Auth ──────────────────────────────────────────────────────────────────
  jwtSecret: process.env.JWT_SECRET || "dev-secret-change-me",
  jwtTtl: process.env.JWT_TTL || "12h",
  maxLoginAttempts: parseInt(process.env.MAX_LOGIN_ATTEMPTS || "5", 10),
  lockoutMinutes: parseInt(process.env.LOCKOUT_MINUTES || "15", 10),

  // ─── Redis (optional, for horizontal scaling) ──────────────────────────────
  redisUrl: process.env.REDIS_URL || "",
  redisEnabled: !!process.env.REDIS_URL,

  // ─── Push Notifications ────────────────────────────────────────────────────
  vapidContact: process.env.VAPID_CONTACT || "mailto:admin@agencia.com",

  // ─── WhatsApp (Twilio) ─────────────────────────────────────────────────────
  twilioSid: process.env.TWILIO_ACCOUNT_SID || "",
  twilioToken: process.env.TWILIO_AUTH_TOKEN || "",
  twilioPhone: process.env.TWILIO_PHONE || "",
  whatsappEnabled: !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN),

  // ─── Delivery Pricing ──────────────────────────────────────────────────────
  fareDay: parseInt(process.env.FARE_DAY || "3000", 10),
  fareNight: parseInt(process.env.FARE_NIGHT || "4000", 10),
  fareNightStartHour: parseInt(process.env.FARE_NIGHT_HOUR || "21", 10),
  timezone: process.env.TZ || "America/Bogota",

  // ─── Offline Detection ─────────────────────────────────────────────────────
  offlineThresholdSeconds: parseInt(process.env.OFFLINE_THRESHOLD_SECONDS || "90", 10),
  offlineCheckIntervalMs: parseInt(process.env.OFFLINE_CHECK_INTERVAL_MS || "10000", 10),

  // ─── Alarm ─────────────────────────────────────────────────────────────────
  alarmHour: parseInt(process.env.ALARM_HOUR || "8", 10),
  alarmMinute: parseInt(process.env.ALARM_MINUTE || "0", 10),
  alarmEnabled: process.env.ALARM_ENABLED !== "false",

  // ─── Rate Limiting ─────────────────────────────────────────────────────────
  rateLimitWindowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || "15000", 10),
  rateLimitMax: parseInt(process.env.RATE_LIMIT_MAX || "100", 10),

  // ─── Logging ───────────────────────────────────────────────────────────────
  logLevel: process.env.LOG_LEVEL || "info",
  logFormat: process.env.LOG_FORMAT || "json", // 'json' | 'pretty'
};

export default config;
