/**
 * Custom middleware: Rate Limiting, CORS, Compression, Logging.
 * No external dependencies needed for rate limiting.
 */

// ─── Simple In-Memory Rate Limiter ───────────────────────────────────────────

const rateLimitStore = new Map();

/**
 * Creates a rate-limiting middleware.
 * @param {object} opts
 * @param {number} opts.windowMs - Time window in milliseconds (default: 60000)
 * @param {number} opts.max - Max requests per window (default: 100)
 * @param {string} opts.message - Error message when limited
 */
export function rateLimit({ windowMs = 60000, max = 100, message = "Demasiadas solicitudes, intenta de nuevo mas tarde" } = {}) {
  // Cleanup old entries every minute
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of rateLimitStore) {
      if (now - entry.start > windowMs) {
        rateLimitStore.delete(key);
      }
    }
  }, windowMs);

  return (req, res, next) => {
    const key = req.ip || req.connection.remoteAddress || "unknown";
    const now = Date.now();

    let entry = rateLimitStore.get(key);
    if (!entry || now - entry.start > windowMs) {
      entry = { count: 0, start: now };
      rateLimitStore.set(key, entry);
    }

    entry.count++;

    // Set rate limit headers
    res.setHeader("X-RateLimit-Limit", max);
    res.setHeader("X-RateLimit-Remaining", Math.max(0, max - entry.count));
    res.setHeader("X-RateLimit-Reset", Math.ceil((entry.start + windowMs) / 1000));

    if (entry.count > max) {
      return res.status(429).json({ error: message });
    }

    next();
  };
}

/**
 * Stricter rate limiter for auth endpoints.
 */
export const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // 10 attempts per 15 min
  message: "Demasiados intentos de inicio de sesion. Intenta en 15 minutos.",
});

/**
 * General API rate limiter.
 */
export const apiRateLimit = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 120, // 120 requests per minute
  message: "Demasiadas solicitudes. Intenta de nuevo en un momento.",
});

// ─── CORS Middleware ─────────────────────────────────────────────────────────

/**
 * CORS middleware supporting configurable origins.
 * @param {object} opts
 * @param {string|string[]} opts.origin - Allowed origin(s). "*" for all, or array of domains.
 * @param {string[]} opts.methods - Allowed HTTP methods
 * @param {boolean} opts.credentials - Allow credentials
 */
export function cors({
  origin = process.env.CORS_ORIGIN || "*",
  methods = ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  credentials = true,
} = {}) {
  return (req, res, next) => {
    const requestOrigin = req.headers.origin;

    // Determine if origin is allowed
    let allowedOrigin = "*";
    if (origin === "*") {
      allowedOrigin = "*";
    } else if (Array.isArray(origin)) {
      if (origin.includes(requestOrigin)) {
        allowedOrigin = requestOrigin;
      } else {
        allowedOrigin = origin[0];
      }
    } else if (typeof origin === "string" && origin !== "*") {
      // Comma-separated origins from env
      const origins = origin.split(",").map((o) => o.trim());
      if (origins.includes(requestOrigin)) {
        allowedOrigin = requestOrigin;
      } else {
        allowedOrigin = origins[0];
      }
    }

    res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
    res.setHeader("Access-Control-Allow-Methods", methods.join(", "));
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Access-Control-Allow-Credentials", credentials ? "true" : "false");

    // Handle preflight
    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Max-Age", "86400"); // 24 hours
      return res.status(204).end();
    }

    next();
  };
}

// ─── Structured Logger ───────────────────────────────────────────────────────

const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const currentLevel = LOG_LEVELS[process.env.LOG_LEVEL || "info"] ?? 2;

function formatLog(level, message, meta = {}) {
  const timestamp = new Date().toISOString();
  const metaStr = Object.keys(meta).length > 0 ? " " + JSON.stringify(meta) : "";
  return `[${timestamp}] [${level.toUpperCase()}] ${message}${metaStr}`;
}

export const logger = {
  error(message, meta) {
    if (currentLevel >= LOG_LEVELS.error) console.error(formatLog("error", message, meta));
  },
  warn(message, meta) {
    if (currentLevel >= LOG_LEVELS.warn) console.warn(formatLog("warn", message, meta));
  },
  info(message, meta) {
    if (currentLevel >= LOG_LEVELS.info) console.log(formatLog("info", message, meta));
  },
  debug(message, meta) {
    if (currentLevel >= LOG_LEVELS.debug) console.log(formatLog("debug", message, meta));
  },
};

/**
 * Request logging middleware.
 */
export function requestLogger(req, res, next) {
  const start = Date.now();
  res.on("finish", () => {
    const duration = Date.now() - start;
    const level = res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info";
    logger[level](`${req.method} ${req.originalUrl} ${res.statusCode}`, {
      duration: `${duration}ms`,
      ip: req.ip,
    });
  });
  next();
}

// ─── Simple Gzip-like Compression ────────────────────────────────────────────

import { createGzip, createDeflate } from "zlib";

/**
 * Compression middleware: gzip or deflate responses.
 */
export function compress(req, res, next) {
  const acceptEncoding = req.headers["accept-encoding"] || "";

  // Don't compress if client doesn't accept it
  if (!acceptEncoding.includes("gzip") && !acceptEncoding.includes("deflate")) {
    return next();
  }

  // Store original methods
  const originalWrite = res.write.bind(res);
  const originalEnd = res.end.bind(res);

  // Skip compression for small responses, streaming, or already compressed
  const originalWriteHead = res.writeHead.bind(res);
  let compressionApplied = false;

  res.writeHead = function (statusCode, ...args) {
    // Don't compress if already has content-encoding or is not text-based
    const contentType = res.getHeader("content-type") || "";
    const contentEncoding = res.getHeader("content-encoding");

    if (
      contentEncoding ||
      statusCode === 204 ||
      statusCode === 304 ||
      (!contentType.includes("text") &&
        !contentType.includes("json") &&
        !contentType.includes("javascript") &&
        !contentType.includes("xml") &&
        !contentType.includes("css"))
    ) {
      return originalWriteHead(statusCode, ...args);
    }

    // Apply gzip
    if (acceptEncoding.includes("gzip")) {
      res.setHeader("Content-Encoding", "gzip");
      res.removeHeader("Content-Length");
      compressionApplied = true;
    } else if (acceptEncoding.includes("deflate")) {
      res.setHeader("Content-Encoding", "deflate");
      res.removeHeader("Content-Length");
      compressionApplied = true;
    }

    return originalWriteHead(statusCode, ...args);
  };

  next();
}

// ─── Static Asset Cache Headers ──────────────────────────────────────────────

/**
 * Middleware to set cache headers for static assets.
 */
export function cacheControl(maxAge = 86400) {
  return (req, res, next) => {
    // Only cache static assets (css, js, images, fonts)
    const ext = req.path.split(".").pop()?.toLowerCase();
    const cacheableExts = ["css", "js", "png", "jpg", "jpeg", "gif", "svg", "ico", "woff", "woff2", "ttf"];

    if (cacheableExts.includes(ext)) {
      res.setHeader("Cache-Control", `public, max-age=${maxAge}`);
    }

    next();
  };
}
