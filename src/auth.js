import { Router } from "express";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import db from "../db/database.js";
import config from "./config.js";

const JWT_SECRET = config.jwt.secret;
const ACCESS_TOKEN_TTL = config.jwt.accessTokenTTL;
const REFRESH_TOKEN_TTL = config.jwt.refreshTokenTTL;

// ─── Token Functions ─────────────────────────────────────────────────────────

export function signToken(user) {
  return jwt.sign(
    { id: user.id, name: user.name, email: user.email, role: user.role },
    JWT_SECRET,
    { expiresIn: ACCESS_TOKEN_TTL }
  );
}

export function signRefreshToken(user) {
  return jwt.sign(
    { id: user.id, type: "refresh" },
    JWT_SECRET,
    { expiresIn: REFRESH_TOKEN_TTL }
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
  // Reject refresh tokens used as access tokens
  if (payload.type === "refresh") return res.status(401).json({ error: "Token invalido" });
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

const MAX_LOGIN_ATTEMPTS = config.login.maxAttempts;
const LOCKOUT_MINUTES = config.login.lockoutMinutes;
const loginAttempts = new Map(); // key: email|IP -> { count, lockedUntil }

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

// Cleanup expired entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of loginAttempts) {
    if (entry.lockedUntil && now >= entry.lockedUntil) {
      loginAttempts.delete(key);
    }
  }
}, config.login.cleanupIntervalMs);

// ─── Refresh Token Store ─────────────────────────────────────────────────────
// In production you'd store these in the database or Redis.
// This in-memory store works for single-instance deployments.

const refreshTokens = new Map(); // token -> { userId, expiresAt, family }

function storeRefreshToken(token, userId) {
  const decoded = jwt.decode(token);
  const family = crypto.randomUUID();
  refreshTokens.set(token, {
    userId,
    expiresAt: decoded.exp * 1000,
    family,
  });
  return family;
}

function revokeRefreshToken(token) {
  refreshTokens.delete(token);
}

function revokeAllUserTokens(userId) {
  for (const [token, data] of refreshTokens) {
    if (data.userId === userId) {
      refreshTokens.delete(token);
    }
  }
}

// Cleanup expired refresh tokens every hour
setInterval(() => {
  const now = Date.now();
  for (const [token, data] of refreshTokens) {
    if (now >= data.expiresAt) {
      refreshTokens.delete(token);
    }
  }
}, 60 * 60 * 1000);

// ─── POST /api/auth/login ────────────────────────────────────────────────────

router.post("/login", (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: "Email y contrasena son obligatorios" });
  }

  const key = getLoginKey(req);

  // Check if locked out
  if (isLockedOut(key)) {
    const minRemaining = getLockoutRemaining(key);
    return res.status(429).json({
      error: `Cuenta bloqueada por demasiados intentos fallidos. Intenta de nuevo en ${minRemaining} minuto${minRemaining !== 1 ? "s" : ""}.`,
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
      error: `Credenciales invalidas. Te quedan ${remaining} intento${remaining !== 1 ? "s" : ""}.`,
      attempts_remaining: remaining,
    });
  }

  // Successful login: clear attempts
  clearAttempts(key);

  const accessToken = signToken(user);
  const refreshToken = signRefreshToken(user);
  storeRefreshToken(refreshToken, user.id);

  // Set access token as httpOnly cookie
  res.cookie("token", accessToken, {
    httpOnly: true,
    sameSite: "lax",
    secure: config.jwt.cookieSecure,
    maxAge: config.jwt.accessTokenMaxAge,
  });

  // Set refresh token as httpOnly cookie (longer lived, stricter path)
  res.cookie("refresh_token", refreshToken, {
    httpOnly: true,
    sameSite: "lax",
    secure: config.jwt.cookieSecure,
    path: "/api/auth",
    maxAge: config.jwt.refreshTokenMaxAge,
  });

  res.json({
    token: accessToken,
    refresh_token: refreshToken,
    expires_in: config.jwt.accessTokenMaxAge / 1000,
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
  });
});

// ─── POST /api/auth/refresh ──────────────────────────────────────────────────

router.post("/refresh", (req, res) => {
  // Extract refresh token from cookie or body
  const refreshToken =
    req.cookies?.refresh_token ||
    req.body?.refresh_token;

  if (!refreshToken) {
    return res.status(401).json({ error: "Refresh token no proporcionado" });
  }

  // Verify the refresh token signature
  const payload = verifyToken(refreshToken);
  if (!payload || payload.type !== "refresh") {
    return res.status(401).json({ error: "Refresh token invalido o expirado" });
  }

  // Check if the token is in our store (not revoked)
  const storedData = refreshTokens.get(refreshToken);
  if (!storedData) {
    // Possible token reuse attack — revoke all tokens for this user
    revokeAllUserTokens(payload.id);
    return res.status(401).json({ error: "Refresh token revocado. Inicia sesion nuevamente." });
  }

  // Get current user from database (they might have been deleted or role changed)
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(payload.id);
  if (!user) {
    revokeRefreshToken(refreshToken);
    return res.status(401).json({ error: "Usuario no encontrado" });
  }

  // Rotate: revoke old refresh token, issue new pair
  revokeRefreshToken(refreshToken);

  const newAccessToken = signToken(user);
  const newRefreshToken = signRefreshToken(user);
  storeRefreshToken(newRefreshToken, user.id);

  res.cookie("token", newAccessToken, {
    httpOnly: true,
    sameSite: "lax",
    secure: config.jwt.cookieSecure,
    maxAge: config.jwt.accessTokenMaxAge,
  });

  res.cookie("refresh_token", newRefreshToken, {
    httpOnly: true,
    sameSite: "lax",
    secure: config.jwt.cookieSecure,
    path: "/api/auth",
    maxAge: config.jwt.refreshTokenMaxAge,
  });

  res.json({
    token: newAccessToken,
    refresh_token: newRefreshToken,
    expires_in: config.jwt.accessTokenMaxAge / 1000,
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
  });
});

// ─── POST /api/auth/logout ───────────────────────────────────────────────────

router.post("/logout", (req, res) => {
  // Revoke refresh token if present
  const refreshToken = req.cookies?.refresh_token || req.body?.refresh_token;
  if (refreshToken) {
    revokeRefreshToken(refreshToken);
  }

  res.clearCookie("token");
  res.clearCookie("refresh_token", { path: "/api/auth" });
  res.json({ ok: true });
});

// ─── GET /api/auth/me ────────────────────────────────────────────────────────

router.get("/me", requireAuth, (req, res) => {
  res.json({ user: req.user });
});

export default router;
