import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cookieParser from "cookie-parser";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

import db from "./db/database.js";
import authRouter, { verifyToken } from "./src/auth.js";
import driversRouter from "./src/drivers.js";
import createOrdersRouter from "./src/orders.js";
import createRestaurantRouter from "./src/restaurants.js";
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
  logger,
} from "./src/middleware.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: process.env.CORS_ORIGIN || "*",
    credentials: true,
  },
});

const PORT = process.env.PORT || 3000;

// ─── Global Middleware ───────────────────────────────────────────────────────

// CORS
app.use(cors());

// Request logging
app.use(requestLogger);

// Body parsing
app.use(express.json());
app.use(cookieParser());

// Cache headers for static assets
app.use(cacheControl(86400)); // 24 hours

// Static files
app.use(express.static(join(__dirname, "public")));

// Make io accessible to routes
app.set("io", io);

// ─── Health Check ────────────────────────────────────────────────────────────

app.get("/api/health", (req, res) => {
  const uptime = process.uptime();
  const memUsage = process.memoryUsage();
  res.json({
    status: "ok",
    uptime: Math.round(uptime),
    uptime_human: `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`,
    memory: {
      rss: Math.round(memUsage.rss / 1024 / 1024) + " MB",
      heap_used: Math.round(memUsage.heapUsed / 1024 / 1024) + " MB",
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

// Restaurant routes
const restaurantRouter = createRestaurantRouter(io);
app.use("/api/restaurant", restaurantRouter);

// Reports (admin only)
app.use("/api/reports", reportsRouter);

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
  } else if (user.role === "restaurant") {
    socket.join("restaurants");
    socket.join(`restaurant:${user.id}`);
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

const OFFLINE_AFTER_MS = 30_000;
setInterval(() => {
  const cutoff = new Date(Date.now() - OFFLINE_AFTER_MS).toISOString();
  const stale = db
    .prepare("SELECT user_id FROM drivers WHERE status != 'offline' AND last_seen < ?")
    .all(cutoff);

  for (const { user_id } of stale) {
    db.prepare("UPDATE drivers SET status = 'offline' WHERE user_id = ?").run(user_id);
    io.to("admins").emit("driver:offline", { id: user_id });
  }
}, 10_000);

// ─── Location History Cleanup (30-day retention) ─────────────────────────────

const RETENTION_DAYS = parseInt(process.env.LOCATION_HISTORY_RETENTION_DAYS || "30", 10);

function cleanupLocationHistory() {
  try {
    const cutoffDate = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const result = db.prepare("DELETE FROM location_history WHERE timestamp < ?").run(cutoffDate);
    if (result.changes > 0) {
      logger.info(`Limpieza de location_history: ${result.changes} registros eliminados (> ${RETENTION_DAYS} dias)`);
    }
  } catch (err) {
    logger.error("Error limpiando location_history", { error: err.message });
  }
}

// Run cleanup every 6 hours
setInterval(cleanupLocationHistory, 6 * 60 * 60 * 1000);
// Also run once on startup (after 30 seconds)
setTimeout(cleanupLocationHistory, 30_000);

// ─── Start Server ────────────────────────────────────────────────────────────

httpServer.listen(PORT, () => {
  logger.info(`Delivery Platform corriendo en http://localhost:${PORT}`);
  logger.info(`Panel de control:     http://localhost:${PORT}/`);
  logger.info(`App del repartidor:   http://localhost:${PORT}/driver.html`);
  logger.info(`App del restaurante:  http://localhost:${PORT}/restaurant.html`);
  logger.info(`Health check:         http://localhost:${PORT}/api/health`);
});
