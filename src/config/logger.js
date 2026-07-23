/**
 * Structured Logger — JSON output for production, pretty for development.
 * Replaces scattered console.log calls with a unified logging interface.
 */
import config from "./index.js";

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const currentLevel = LEVELS[config.logLevel] ?? LEVELS.info;

function timestamp() {
  return new Date().toISOString();
}

function formatMessage(level, msg, meta = {}) {
  const entry = {
    ts: timestamp(),
    level,
    msg,
    ...meta,
  };

  if (config.logFormat === "pretty" || !config.isProduction) {
    const metaStr = Object.keys(meta).length ? " " + JSON.stringify(meta) : "";
    return `[${entry.ts}] [${level.toUpperCase()}] ${msg}${metaStr}`;
  }

  return JSON.stringify(entry);
}

export const logger = {
  error(msg, meta) {
    if (currentLevel >= LEVELS.error) console.error(formatMessage("error", msg, meta));
  },
  warn(msg, meta) {
    if (currentLevel >= LEVELS.warn) console.warn(formatMessage("warn", msg, meta));
  },
  info(msg, meta) {
    if (currentLevel >= LEVELS.info) console.log(formatMessage("info", msg, meta));
  },
  debug(msg, meta) {
    if (currentLevel >= LEVELS.debug) console.log(formatMessage("debug", msg, meta));
  },

  // Express middleware for request logging
  requestLogger(req, res, next) {
    const start = Date.now();
    res.on("finish", () => {
      const duration = Date.now() - start;
      const level = res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info";
      logger[level](`${req.method} ${req.originalUrl} ${res.statusCode}`, {
        method: req.method,
        url: req.originalUrl,
        status: res.statusCode,
        duration_ms: duration,
        ip: req.ip,
      });
    });
    next();
  },
};

export default logger;
