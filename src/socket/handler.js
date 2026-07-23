/**
 * Socket.IO connection handler — extracted from server.js
 * Handles: driver location, chat, walkie-talkie, order tracking rooms.
 */
import db from "../../db/database.js";
import { verifyToken } from "../auth.js";
import { notifyAdmins } from "../notifications.js";
import logger from "../config/logger.js";

/**
 * Sets up Socket.IO authentication middleware and connection handlers.
 * @param {import("socket.io").Server} io
 */
export function setupSocketHandlers(io) {
  // ─── Authentication Middleware ───────────────────────────────────────────
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

  // ─── Connection Handler ─────────────────────────────────────────────────
  io.on("connection", (socket) => {
    const user = socket.data.user;

    // Tracking-only connections (unauthenticated customers)
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
      socket.join(`restaurant:${user.id}`);
    }

    // ─── Driver Location Update ──────────────────────────────────────────
    socket.on("driver:update", async (payload) => {
      if (!payload || typeof payload.lat !== "number" || typeof payload.lng !== "number") return;
      if (user.role !== "driver") return;

      const speed = typeof payload.speed === "number" ? payload.speed : 0;

      try {
        await db.run(
          `UPDATE drivers SET lat = ?, lng = ?, speed = ?, last_seen = datetime('now'), status = 'available' WHERE user_id = ?`,
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

        // Record history for active orders
        const activeOrders = await db.all(
          "SELECT id, code FROM orders WHERE driver_id = ? AND status IN ('assigned', 'picked_up', 'on_the_way')",
          [user.id]
        );
        for (const order of activeOrders) {
          await db.run(
            "INSERT INTO location_history (driver_id, order_id, lat, lng) VALUES (?, ?, ?, ?)",
            [user.id, order.id, payload.lat, payload.lng]
          );
          io.to(`tracking:${order.code}`).emit("driver:location", {
            id: user.id,
            name: user.name,
            lat: payload.lat,
            lng: payload.lng,
            speed,
          });
        }
      } catch (err) {
        logger.error("driver:update error", { error: err.message, userId: user.id });
      }
    });

    // ─── Chat ────────────────────────────────────────────────────────────
    socket.on("chat:send", async (payload) => {
      if (!payload || !payload.body || !String(payload.body).trim()) return;
      const body = String(payload.body).trim().slice(0, 1000);
      const driverId = user.role === "driver" ? user.id : parseInt(payload.driverId, 10);
      if (!driverId) return;

      try {
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
        io.to("admins").emit("chat:message", msg);
        io.to(`driver:${driverId}`).emit("chat:message", msg);
      } catch (err) {
        logger.error("chat:send error", { error: err.message });
      }
    });

    // ─── Walkie-Talkie ───────────────────────────────────────────────────
    socket.on("walkie:audio", (payload) => {
      if (!payload || !payload.audio) return;
      const driverId = user.role === "driver" ? user.id : parseInt(payload.driverId, 10);
      if (!driverId) return;

      const audioMsg = {
        audio: payload.audio,
        sender_id: user.id,
        sender_role: user.role,
        sender_name: user.name,
        driver_id: driverId,
        timestamp: new Date().toISOString(),
      };

      if (user.role === "admin") {
        io.to(`driver:${driverId}`).emit("walkie:audio", audioMsg);
      } else {
        io.to("admins").emit("walkie:audio", audioMsg);
      }
    });

    socket.on("walkie:talking", (payload) => {
      const driverId = user.role === "driver" ? user.id : parseInt(payload?.driverId, 10);
      if (!driverId) return;
      const talkMsg = { talking: payload.talking, sender_id: user.id, sender_role: user.role, sender_name: user.name, driver_id: driverId };
      if (user.role === "admin") {
        io.to(`driver:${driverId}`).emit("walkie:talking", talkMsg);
      } else {
        io.to("admins").emit("walkie:talking", talkMsg);
      }
    });

    // ─── Driver Stop / SOS ───────────────────────────────────────────────
    socket.on("driver:stop", async () => {
      if (user.role !== "driver") return;
      await db.run("UPDATE drivers SET status = 'offline', last_seen = datetime('now') WHERE user_id = ?", [user.id]);
      io.to("admins").emit("driver:offline", { id: user.id });
      notifyAdmins(io, "driver_offline", { id: user.id, name: user.name });
    });

    socket.on("driver:sos", (payload) => {
      io.to("admins").emit("driver:sos", { id: user.id, name: user.name, ...payload });
      notifyAdmins(io, "driver_sos", { id: user.id, name: user.name });
    });

    // ─── Disconnect ──────────────────────────────────────────────────────
    socket.on("disconnect", async () => {
      if (user.role === "driver") {
        await db.run("UPDATE drivers SET status = 'offline', last_seen = datetime('now') WHERE user_id = ?", [user.id]);
        io.to("admins").emit("driver:offline", { id: user.id });
        notifyAdmins(io, "driver_offline", { id: user.id, name: user.name });
      }
    });
  });

  logger.info("Socket.IO handlers configured");
}
