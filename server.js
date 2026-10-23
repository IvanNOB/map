import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cookieParser from "cookie-parser";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

import config, { validateConfig } from "./src/config.js";
import db from "./db/database.js";
import authRouter, { verifyToken } from "./src/auth.js";
import driversRouter from "./src/drivers.js";
import createOrdersRouter from "./src/orders.js";
import createLocationRouter from "./src/location.js";
import trackingRouter from "./src/tracking.js";
import reportsRouter from "./src/reports.js";
import { notifyAdmins } from "./src/notifications.js";
import {
  apiRateLimit,
  authRateLimit,
  cors,
  requestLogger,
  cacheControl,
  securityHeaders,
  logger,
} from "./src/middleware.js";

// ─── Validate configuration before starting ──────────────────────────────────
validateConfig();

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: config.cors.origin,
    credentials: true,
  },
  // Production Socket.IO settings
  pingTimeout: 20000,
  pingInterval: 25000,
});

// ─── Trust proxy (needed behind reverse proxy / Docker) ──────────────────────
if (config.isProduction) {
  app.set("trust proxy", 1);
}

// ─── Global Middleware ───────────────────────────────────────────────────────

// Security headers (CSP, HSTS, X-Frame-Options, etc.)
app.use(securityHeaders());

// CORS
app.use(cors());

// Request logging
app.use(requestLogger);

// Body parsing
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

// Cache headers for static assets
app.use(cacheControl(config.cache.staticMaxAge));

// Static files
app.use(express.static(join(__dirname, "public")));

// Make io accessible to routes
app.set("io", io);

// ─── Health Check ────────────────────────────────────────────────────────────

app.get("/api/health", (req, res) => {
  const uptime = process.uptime();
  const memUsage = process.memoryUsage();
  const dbStats = db.getStats();

  res.json({
    status: "ok",
    env: config.env,
    uptime: Math.round(uptime),
    uptime_human: `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`,
    memory: {
      rss: Math.round(memUsage.rss / 1024 / 1024) + " MB",
      heap_used: Math.round(memUsage.heapUsed / 1024 / 1024) + " MB",
    },
    database: {
      saves: dbStats.saves,
      errors: dbStats.errors,
      last_save: dbStats.lastSave,
    },
    connections: {
      sockets: io.engine?.clientsCount || 0,
    },
    timestamp: new Date().toISOString(),
  });
});

// ─── Routes ──────────────────────────────────────────────────────────────────

// Auth routes with stricter rate limiting
app.use("/api/auth", authRateLimit, authRouter);

// API rate limiting for all other routes
app.use("/api", apiRateLimit);

app.use("/api/drivers", driversRouter);

const ordersRouter = createOrdersRouter(io);
app.use("/api/orders", ordersRouter);

// Mount /api/stats as an alias - forward to ordersRouter's /stats handler
app.use("/api/stats", (req, res, next) => {
  req.url = "/stats";
  ordersRouter(req, res, next);
});

// Location history routes
const locationRouter = createLocationRouter(io);
app.use("/api/location", locationRouter);

// Public tracking (no auth)
app.use("/api/track", trackingRouter);

// Reports (admin only)
app.use("/api/reports", reportsRouter);

// ─── 404 handler ─────────────────────────────────────────────────────────────

app.use("/api/*", (req, res) => {
  res.status(404).json({ error: "Endpoint no encontrado" });
});

// ─── Global error handler ────────────────────────────────────────────────────

app.use((err, req, res, _next) => {
  logger.error(`Error no manejado: ${err.message}`, { stack: err.stack, url: req.originalUrl });
  res.status(500).json({
    error: config.isProduction ? "Error interno del servidor" : err.message,
  });
});

// ─── Socket.IO Authentication Middleware ─────────────────────────────────────

io.use((socket, next) => {
  // Allow unauthenticated connections for order tracking
  const orderCode = socket.handshake.query?.order_code;
  if (orderCode) {
    socket.data.trackingCode = orderCode;
    socket.data.user = null;
    return next();
  }

  const token =
    socket.handshake.auth?.token ||
    (socket.handshake.headers.cookie &&
      socket.handshake.headers.cookie
        .split(";")
        .map((c) => c.trim())
        .find((c) => c.startsWith("token="))
        ?.slice(6));

  if (!token) return next(new Error("No autenticado"));

  const user = verifyToken(token);
  if (!user) return next(new Error("Token invalido"));

  socket.data.user = user;
  next();
});

// ─── Socket.IO Connection Handler ────────────────────────────────────────────

io.on("connection", (socket) => {
  const user = socket.data.user;

  // Handle tracking-only connections (unauthenticated customers)
  if (socket.data.trackingCode) {
    socket.join(`tracking:${socket.data.trackingCode}`);
    return;
  }

  if (!user) return;

  // Join role-based rooms
  if (user.role === "admin") {
    socket.join("admins");
  } else if (user.role === "driver") {
    socket.join("drivers");
    socket.join(`driver:${user.id}`);
  }

  // Driver location update
  socket.on("driver:update", (payload) => {
    if (!payload || typeof payload.lat !== "number" || typeof payload.lng !== "number") {
      return;
    }
    if (user.role !== "driver") return;

    const speed = typeof payload.speed === "number" ? payload.speed : 0;

    db.prepare(
      `UPDATE drivers SET lat = ?, lng = ?, speed = ?, last_seen = datetime('now'), status = 'available'
       WHERE user_id = ?`
    ).run(payload.lat, payload.lng, speed, user.id);

    // Broadcast to admins
    io.to("admins").emit("driver:location", {
      id: user.id,
      name: user.name,
      lat: payload.lat,
      lng: payload.lng,
      speed,
      last_seen: new Date().toISOString(),
    });

    // Insert into location_history for active orders
    const activeOrders = db
      .prepare(
        "SELECT id, code FROM orders WHERE driver_id = ? AND status IN ('assigned', 'picked_up', 'on_the_way')"
      )
      .all(user.id);

    for (const order of activeOrders) {
      db.prepare(
        "INSERT INTO location_history (driver_id, order_id, lat, lng) VALUES (?, ?, ?, ?)"
      ).run(user.id, order.id, payload.lat, payload.lng);

      // Emit to tracking rooms for this order
      io.to(`tracking:${order.code}`).emit("driver:location", {
        id: user.id,
        name: user.name,
        lat: payload.lat,
        lng: payload.lng,
        speed,
      });
    }
  });

  // Driver stops sharing location
  socket.on("driver:stop", () => {
    if (user.role !== "driver") return;
    db.prepare("UPDATE drivers SET status = 'offline', last_seen = datetime('now') WHERE user_id = ?").run(
      user.id
    );
    io.to("admins").emit("driver:offline", { id: user.id });
    notifyAdmins(io, "driver_offline", { id: user.id, name: user.name });
  });

  // Disconnect
  socket.on("disconnect", () => {
    if (user.role === "driver") {
      db.prepare("UPDATE drivers SET status = 'offline', last_seen = datetime('now') WHERE user_id = ?").run(
        user.id
      );
      io.to("admins").emit("driver:offline", { id: user.id });
      notifyAdmins(io, "driver_offline", { id: user.id, name: user.name });
    }
  });
});

// ─── Offline Detection Interval ──────────────────────────────────────────────

const offlineInterval = setInterval(() => {
  const cutoff = new Date(Date.now() - config.tracking.offlineAfterMs).toISOString();
  const stale = db
    .prepare("SELECT user_id FROM drivers WHERE status != 'offline' AND last_seen < ?")
    .all(cutoff);

  for (const { user_id } of stale) {
    db.prepare("UPDATE drivers SET status = 'offline' WHERE user_id = ?").run(user_id);
    io.to("admins").emit("driver:offline", { id: user_id });
  }
}, config.tracking.offlineCheckIntervalMs);

// ─── Location History Cleanup ────────────────────────────────────────────────

function cleanupLocationHistory() {
  try {
    const cutoffDate = new Date(
      Date.now() - config.tracking.locationHistoryRetentionDays * 24 * 60 * 60 * 1000
    ).toISOString();
    const result = db.prepare("DELETE FROM location_history WHERE timestamp < ?").run(cutoffDate);
    if (result.changes > 0) {
      logger.info(
        `Limpieza de location_history: ${result.changes} registros eliminados (> ${config.tracking.locationHistoryRetentionDays} dias)`
      );
    }
  } catch (err) {
    logger.error("Error limpiando location_history", { error: err.message });
  }
}

const cleanupInterval = setInterval(cleanupLocationHistory, config.tracking.locationCleanupIntervalMs);
const cleanupTimeout = setTimeout(cleanupLocationHistory, config.tracking.locationCleanupDelayMs);

// ─── Graceful Shutdown ───────────────────────────────────────────────────────

let isShuttingDown = false;

async function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info(`Recibida senal ${signal}. Iniciando apagado graceful...`);

  // Stop accepting new connections
  httpServer.close(() => {
    logger.info("Servidor HTTP cerrado (no mas conexiones nuevas)");
  });

  // Clear intervals and timeouts
  clearInterval(offlineInterval);
  clearInterval(cleanupInterval);
  clearTimeout(cleanupTimeout);

  // Notify connected clients
  io.emit("server:shutdown", { message: "Servidor reiniciandose. Reconecta en unos segundos." });

  // Close all Socket.IO connections gracefully
  try {
    const sockets = await io.fetchSockets();
    for (const socket of sockets) {
      socket.disconnect(true);
    }
    logger.info(`${sockets.length} conexiones WebSocket cerradas`);
  } catch (err) {
    logger.warn("Error cerrando sockets", { error: err.message });
  }

  // Close Socket.IO server
  io.close();

  // Close database (ensures final save)
  try {
    db.close();
    logger.info("Base de datos cerrada y guardada");
  } catch (err) {
    logger.error("Error cerrando base de datos", { error: err.message });
  }

  logger.info("Apagado graceful completado");
  process.exit(0);
}

// Force exit if graceful shutdown takes too long
function forceShutdown(signal) {
  setTimeout(() => {
    logger.error(`Apagado forzado despues de ${config.shutdown.timeoutMs}ms (senal: ${signal})`);
    process.exit(1);
  }, config.shutdown.timeoutMs).unref();

  gracefulShutdown(signal);
}

// Handle shutdown signals
process.on("SIGTERM", () => forceShutdown("SIGTERM"));
process.on("SIGINT", () => forceShutdown("SIGINT"));

// Handle uncaught errors
process.on("uncaughtException", (err) => {
  logger.error("Excepcion no capturada", { error: err.message, stack: err.stack });
  forceShutdown("uncaughtException");
});

process.on("unhandledRejection", (reason) => {
  logger.error("Promesa rechazada no manejada", { reason: String(reason) });
});

// ─── Start Server ────────────────────────────────────────────────────────────

httpServer.listen(config.port, () => {
  logger.info(`Delivery Platform corriendo en http://localhost:${config.port} [${config.env}]`);
  logger.info(`Panel de control:   http://localhost:${config.port}/`);
  logger.info(`App del repartidor: http://localhost:${config.port}/driver.html`);
  logger.info(`Health check:       http://localhost:${config.port}/api/health`);
});
