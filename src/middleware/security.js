/**
 * Security middleware: CORS, headers, rate limiting.
 * Extracted from server.js for modularity.
 */
import config from "../config/index.js";

// ─── CORS ────────────────────────────────────────────────────────────────────

export function cors(req, res, next) {
  const origin = config.corsOrigin;
  res.header("Access-Control-Allow-Origin", origin);
  res.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type,Authorization");
  res.header("Access-Control-Allow-Credentials", "true");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
}

// ─── Security Headers ────────────────────────────────────────────────────────

export function securityHeaders(req, res, next) {
  res.header("X-Content-Type-Options", "nosniff");
  res.header("X-Frame-Options", "DENY");
  res.header("X-XSS-Protection", "1; mode=block");
  res.header("Referrer-Policy", "strict-origin-when-cross-origin");
  res.header("Permissions-Policy", "geolocation=(self), camera=(self), microphone=(self)");
  next();
}

// ─── Rate Limiting (in-memory, per IP) ───────────────────────────────────────

const rateLimitStore = new Map();

export function rateLimit(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  const windowMs = config.rateLimitWindowMs;
  const maxReq = config.rateLimitMax;

  let entry = rateLimitStore.get(ip);
  if (!entry || now - entry.start > windowMs) {
    entry = { count: 0, start: now };
    rateLimitStore.set(ip, entry);
  }
  entry.count++;

  res.setHeader("X-RateLimit-Limit", maxReq);
  res.setHeader("X-RateLimit-Remaining", Math.max(0, maxReq - entry.count));

  if (entry.count > maxReq) {
    return res.status(429).json({ error: "Demasiadas solicitudes, intenta de nuevo en un momento" });
  }
  next();
}

// Cleanup every 30 seconds
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitStore) {
    if (now - entry.start > config.rateLimitWindowMs) {
      rateLimitStore.delete(key);
    }
  }
}, 30_000);
