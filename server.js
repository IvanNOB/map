import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cookieParser from "cookie-parser";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

import db, { init, isPostgres } from "./db/database.js";
import authRouter, { verifyToken } from "./src/auth.js";
import driversRouter from "./src/drivers.js";
import createOrdersRouter from "./src/orders.js";
import createLocationRouter from "./src/location.js";
import trackingRouter from "./src/tracking.js";
import reportsRouter from "./src/reports.js";
import chatRouter from "./src/chat.js";
import customersRouter from "./src/customers.js";
import settingsRouter from "./src/settings.js";
import activityRouter from "./src/activity.js";
import zonesRouter from "./src/zones.js";
import { notifyAdmins } from "./src/notifications.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

const PORT = process.env.PORT || 3000;

// ─── Middleware ──────────────────────────────────────────────────────────────

app.use(express.json());
app.use(cookieParser());
app.use(express.static(join(__dirname, "public")));

// Make io accessible to routes
app.set("io", io);

// ─── Routes ──────────────────────────────────────────────────────────────────

app.use("/api/auth", authRouter);
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

// Chat history
app.use("/api/chat", chatRouter);

// Customers (autocomplete)
app.use("/api/customers", customersRouter);

// Settings (tarifas, comisiones)
app.use("/api/settings", settingsRouter);

// Activity log (auditoria)
app.use("/api/activity", activityRouter);

// Coverage zones
app.use("/api/zones", zonesRouter);

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
  socket.on("driver:update", async (payload) => {
    if (!payload || typeof payload.lat !== "number" || typeof payload.lng !== "number") {
      return;
    }
    if (user.role !== "driver") return;

    const speed = typeof payload.speed === "number" ? payload.speed : 0;

    await db.run(
      `UPDATE drivers SET lat = ?, lng = ?, speed = ?, last_seen = datetime('now'), status = 'available'
       WHERE user_id = ?`,
      [payload.lat, payload.lng, speed, user.id]
    );

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
    const activeOrders = await db.all(
      "SELECT id, code FROM orders WHERE driver_id = ? AND status IN ('assigned', 'picked_up', 'on_the_way')",
      [user.id]
    );

    for (const order of activeOrders) {
      await db.run(
        "INSERT INTO location_history (driver_id, order_id, lat, lng) VALUES (?, ?, ?, ?)",
        [user.id, order.id, payload.lat, payload.lng]
      );

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

  // ─── Chat: send a message (admin <-> driver) ────────────────────────────────
  socket.on("chat:send", async (payload) => {
    if (!payload || !payload.body || !String(payload.body).trim()) return;
    const body = String(payload.body).trim().slice(0, 1000);

    // Driver can only message in their own thread; admin chooses driverId
    const driverId = user.role === "driver" ? user.id : parseInt(payload.driverId, 10);
    if (!driverId) return;

    const info = await db.run(
      "INSERT INTO messages (driver_id, sender_id, sender_role, body) VALUES (?, ?, ?, ?)",
      [driverId, user.id, user.role, body]
    );

    const msg = {
      id: info.lastInsertRowid,
      driver_id: driverId,
      sender_id: user.id,
      sender_role: user.role,
      sender_name: user.name,
      body,
      created_at: new Date().toISOString(),
    };

    // Deliver to all admins and to the specific driver
    io.to("admins").emit("chat:message", msg);
    io.to(`driver:${driverId}`).emit("chat:message", msg);
  });

  // Driver stops sharing location
  socket.on("driver:stop", async () => {
    if (user.role !== "driver") return;
    await db.run(
      "UPDATE drivers SET status = 'offline', last_seen = datetime('now') WHERE user_id = ?",
      [user.id]
    );
    io.to("admins").emit("driver:offline", { id: user.id });
    notifyAdmins(io, "driver_offline", { id: user.id, name: user.name });
  });

  // Disconnect
  socket.on("disconnect", async () => {
    if (user.role === "driver") {
      await db.run(
        "UPDATE drivers SET status = 'offline', last_seen = datetime('now') WHERE user_id = ?",
        [user.id]
      );
      io.to("admins").emit("driver:offline", { id: user.id });
      notifyAdmins(io, "driver_offline", { id: user.id, name: user.name });
    }
  });
});

// ─── Offline Detection Interval ──────────────────────────────────────────────

const OFFLINE_SQL = isPostgres
  ? "SELECT user_id FROM drivers WHERE status != 'offline' AND last_seen < NOW() - INTERVAL '30 seconds'"
  : "SELECT user_id FROM drivers WHERE status != 'offline' AND last_seen < datetime('now', '-30 seconds')";

setInterval(async () => {
  try {
    const stale = await db.all(OFFLINE_SQL);
    for (const { user_id } of stale) {
      await db.run("UPDATE drivers SET status = 'offline' WHERE user_id = ?", [user_id]);
      io.to("admins").emit("driver:offline", { id: user_id });
    }
  } catch (err) {
    console.error("Offline check error:", err.message);
  }
}, 10_000);

// ─── Start Server ────────────────────────────────────────────────────────────

await init();

httpServer.listen(PORT, () => {
  console.log(`\n  Delivery Platform corriendo en http://localhost:${PORT}`);
  console.log(`  Base de datos: ${isPostgres ? "PostgreSQL" : "SQLite (local)"}`);
  console.log(`  Panel de control:   http://localhost:${PORT}/`);
  console.log(`  App del repartidor: http://localhost:${PORT}/driver.html\n`);
});
