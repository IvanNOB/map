/**
 * Centralized configuration.
 * All magic numbers, timeouts, and environment-dependent values live here.
 */

const isProduction = process.env.NODE_ENV === "production";

const config = {
  // ─── Environment ─────────────────────────────────────────────────────────
  env: process.env.NODE_ENV || "development",
  isProduction,
  port: parseInt(process.env.PORT || "3000", 10),

  // ─── JWT / Auth ──────────────────────────────────────────────────────────
  jwt: {
    secret: process.env.JWT_SECRET || (isProduction ? null : "dev-secret-change-me"),
    accessTokenTTL: process.env.TOKEN_TTL || "15m",
    refreshTokenTTL: process.env.REFRESH_TOKEN_TTL || "7d",
    refreshTokenMaxAge: 7 * 24 * 60 * 60 * 1000, // 7 days in ms
    accessTokenMaxAge: 15 * 60 * 1000, // 15 minutes in ms
    cookieSecure: isProduction,
  },

  // ─── Login Attempt Limiter ───────────────────────────────────────────────
  login: {
    maxAttempts: parseInt(process.env.MAX_LOGIN_ATTEMPTS || "5", 10),
    lockoutMinutes: parseInt(process.env.LOCKOUT_MINUTES || "15", 10),
    cleanupIntervalMs: 5 * 60 * 1000, // 5 minutes
  },

  // ─── Rate Limiting ───────────────────────────────────────────────────────
  rateLimit: {
    api: {
      windowMs: 60 * 1000, // 1 minute
      max: parseInt(process.env.API_RATE_LIMIT || "120", 10),
    },
    auth: {
      windowMs: 15 * 60 * 1000, // 15 minutes
      max: parseInt(process.env.AUTH_RATE_LIMIT || "10", 10),
    },
  },

  // ─── Database ────────────────────────────────────────────────────────────
  db: {
    path: process.env.DB_PATH || "./db/data.sqlite",
    autoSaveIntervalMs: parseInt(process.env.DB_SAVE_INTERVAL || "5000", 10),
  },

  // ─── CORS ────────────────────────────────────────────────────────────────
  cors: {
    origin: process.env.CORS_ORIGIN || "*",
  },

  // ─── Driver Tracking ─────────────────────────────────────────────────────
  tracking: {
    offlineAfterMs: parseInt(process.env.OFFLINE_AFTER_MS || "30000", 10),
    offlineCheckIntervalMs: parseInt(process.env.OFFLINE_CHECK_INTERVAL || "10000", 10),
    locationHistoryRetentionDays: parseInt(process.env.LOCATION_HISTORY_RETENTION_DAYS || "30", 10),
    locationCleanupIntervalMs: 6 * 60 * 60 * 1000, // 6 hours
    locationCleanupDelayMs: 30_000, // 30 seconds after startup
  },

  // ─── Static Assets ───────────────────────────────────────────────────────
  cache: {
    staticMaxAge: parseInt(process.env.STATIC_CACHE_MAX_AGE || "86400", 10), // 24 hours
  },

  // ─── Graceful Shutdown ───────────────────────────────────────────────────
  shutdown: {
    timeoutMs: parseInt(process.env.SHUTDOWN_TIMEOUT || "10000", 10),
  },

  // ─── Logging ─────────────────────────────────────────────────────────────
  log: {
    level: process.env.LOG_LEVEL || "info",
  },
};

// ─── Validation ──────────────────────────────────────────────────────────────

export function validateConfig() {
  const errors = [];

  if (isProduction && !process.env.JWT_SECRET) {
    errors.push("JWT_SECRET es OBLIGATORIO en produccion. Genera uno con: node -e \"console.log(require('crypto').randomBytes(64).toString('hex'))\"");
  }

  if (isProduction && config.jwt.secret && config.jwt.secret.length < 32) {
    errors.push("JWT_SECRET debe tener al menos 32 caracteres en produccion.");
  }

  if (isProduction && config.cors.origin === "*") {
    console.warn("[WARN] CORS_ORIGIN esta en '*'. Restringe a dominios especificos en produccion.");
  }

  if (errors.length > 0) {
    console.error("═══════════════════════════════════════════════════════════════");
    console.error("  ERROR DE CONFIGURACION - No se puede iniciar en produccion");
    console.error("═══════════════════════════════════════════════════════════════");
    errors.forEach((err) => console.error("  - " + err));
    console.error("═══════════════════════════════════════════════════════════════");
    process.exit(1);
  }
}

export default config;
