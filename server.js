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

// ─── Socket.IO Authentication Middleware ─────────────────────────────────────

io.use((socket, next) => {
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
  });

  // Driver stops sharing location
  socket.on("driver:stop", () => {
    if (user.role !== "driver") return;
    db.prepare("UPDATE drivers SET status = 'offline', last_seen = datetime('now') WHERE user_id = ?").run(
      user.id
    );
    io.to("admins").emit("driver:offline", { id: user.id });
  });

  // Disconnect
  socket.on("disconnect", () => {
    if (user.role === "driver") {
      db.prepare("UPDATE drivers SET status = 'offline', last_seen = datetime('now') WHERE user_id = ?").run(
        user.id
      );
      io.to("admins").emit("driver:offline", { id: user.id });
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

// ─── Start Server ────────────────────────────────────────────────────────────

httpServer.listen(PORT, () => {
  console.log(`\n  Delivery Platform corriendo en http://localhost:${PORT}`);
  console.log(`  Panel de control:   http://localhost:${PORT}/`);
  console.log(`  App del repartidor: http://localhost:${PORT}/driver.html\n`);
});
