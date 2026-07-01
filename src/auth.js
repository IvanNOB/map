import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import db from "../db/database.js";

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";
const TOKEN_TTL = "12h";

if (!process.env.JWT_SECRET) {
  console.warn("[WARN] JWT_SECRET env var is not set. Using insecure default secret. Set JWT_SECRET in production.");
}

export function signToken(user) {
  return jwt.sign(
    { id: user.id, name: user.name, email: user.email, role: user.role },
    JWT_SECRET,
    { expiresIn: TOKEN_TTL }
  );
}

export function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

/** Extract the JWT from the Authorization header or the auth cookie. */
function extractToken(req) {
  const header = req.headers.authorization;
  if (header && header.startsWith("Bearer ")) return header.slice(7);
  if (req.cookies && req.cookies.token) return req.cookies.token;
  return null;
}

/** Express middleware: requires a valid token, attaches req.user. */
export function requireAuth(req, res, next) {
  const token = extractToken(req);
  const payload = token && verifyToken(token);
  if (!payload) return res.status(401).json({ error: "No autenticado" });
  req.user = payload;
  next();
}

/** Express middleware factory: requires one of the given roles. */
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: "No autorizado" });
    }
    next();
  };
}

const router = Router();

// ─── Login Attempt Limiter ───────────────────────────────────────────────────

const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;
const loginAttempts = new Map(); // key: email or IP -> { count, lockedUntil }

function getLoginKey(req) {
  const email = (req.body.email || "").toLowerCase().trim();
  const ip = req.ip || req.connection.remoteAddress || "unknown";
  return `${email}|${ip}`;
}

function isLockedOut(key) {
  const entry = loginAttempts.get(key);
  if (!entry) return false;
  if (entry.lockedUntil && Date.now() < entry.lockedUntil) {
    return true;
  }
  // Lockout expired, reset
  if (entry.lockedUntil && Date.now() >= entry.lockedUntil) {
    loginAttempts.delete(key);
    return false;
  }
  return false;
}

function recordFailedAttempt(key) {
  const entry = loginAttempts.get(key) || { count: 0, lockedUntil: null };
  entry.count++;
  if (entry.count >= MAX_LOGIN_ATTEMPTS) {
    entry.lockedUntil = Date.now() + LOCKOUT_MINUTES * 60 * 1000;
  }
  loginAttempts.set(key, entry);
  return entry;
}

function clearAttempts(key) {
  loginAttempts.delete(key);
}

function getRemainingAttempts(key) {
  const entry = loginAttempts.get(key);
  if (!entry) return MAX_LOGIN_ATTEMPTS;
  return Math.max(0, MAX_LOGIN_ATTEMPTS - entry.count);
}

function getLockoutRemaining(key) {
  const entry = loginAttempts.get(key);
  if (!entry || !entry.lockedUntil) return 0;
  return Math.max(0, Math.ceil((entry.lockedUntil - Date.now()) / 60000));
}

// Cleanup expired entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of loginAttempts) {
    if (entry.lockedUntil && now >= entry.lockedUntil) {
      loginAttempts.delete(key);
    }
  }
}, 5 * 60 * 1000);

// POST /api/auth/login
router.post("/login", (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: "Email y contraseña son obligatorios" });
  }

  const key = getLoginKey(req);

  // Check if locked out
  if (isLockedOut(key)) {
    const minRemaining = getLockoutRemaining(key);
    return res.status(429).json({
      error: `Cuenta bloqueada por demasiados intentos fallidos. Intenta de nuevo en ${minRemaining} minuto${minRemaining !== 1 ? 's' : ''}.`,
      locked: true,
      retry_after_minutes: minRemaining,
    });
  }

  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(String(email).toLowerCase().trim());
  if (!user || !bcrypt.compareSync(password, user.password)) {
    const entry = recordFailedAttempt(key);
    const remaining = getRemainingAttempts(key);

    if (entry.lockedUntil) {
      return res.status(429).json({
        error: `Demasiados intentos fallidos. Cuenta bloqueada por ${LOCKOUT_MINUTES} minutos.`,
        locked: true,
        retry_after_minutes: LOCKOUT_MINUTES,
      });
    }

    return res.status(401).json({
      error: `Credenciales invalidas. Te quedan ${remaining} intento${remaining !== 1 ? 's' : ''}.`,
      attempts_remaining: remaining,
    });
  }

  // Successful login: clear attempts
  clearAttempts(key);

  const token = signToken(user);
  res.cookie("token", token, {
    httpOnly: true,
    sameSite: "lax",
    maxAge: 12 * 60 * 60 * 1000,
  });

  res.json({
    token,
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
  });
});

// POST /api/auth/logout
router.post("/logout", (req, res) => {
  res.clearCookie("token");
  res.json({ ok: true });
});

// GET /api/auth/me
router.get("/me", requireAuth, (req, res) => {
  res.json({ user: req.user });
});

export default router;
