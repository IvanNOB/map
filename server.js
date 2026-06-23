import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

const PORT = process.env.PORT || 3000;

// Serve the static frontend (dispatcher dashboard + driver page)
app.use(express.static(join(__dirname, "public")));

/**
 * In-memory store of the latest known state for each vehicle/driver.
 * In production you'd persist this to a database (e.g. Redis/Postgres)
 * and add authentication so only authorized drivers/dispatchers connect.
 *
 * Shape: { [driverId]: { id, name, lat, lng, speed, heading, updatedAt } }
 */
const vehicles = new Map();

// Remove vehicles that haven't reported in for a while (considered offline).
const OFFLINE_AFTER_MS = 30_000;
setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const [id, v] of vehicles) {
    if (now - v.updatedAt > OFFLINE_AFTER_MS) {
      vehicles.delete(id);
      io.to("dispatchers").emit("vehicle:offline", { id });
      changed = true;
    }
  }
  if (changed) {
    io.to("dispatchers").emit("vehicles:snapshot", [...vehicles.values()]);
  }
}, 10_000);

io.on("connection", (socket) => {
  // A dispatcher dashboard connects and gets the current snapshot of all vehicles.
  socket.on("dispatcher:join", () => {
    socket.join("dispatchers");
    socket.emit("vehicles:snapshot", [...vehicles.values()]);
  });

  // A driver app sends a location update (with the driver's consent).
  socket.on("driver:update", (payload) => {
    if (!payload || typeof payload.lat !== "number" || typeof payload.lng !== "number") {
      return;
    }

    const id = payload.id || socket.id;
    const vehicle = {
      id,
      name: payload.name || `Vehículo ${id.slice(0, 4)}`,
      lat: payload.lat,
      lng: payload.lng,
      speed: typeof payload.speed === "number" ? payload.speed : null,
      heading: typeof payload.heading === "number" ? payload.heading : null,
      accuracy: typeof payload.accuracy === "number" ? payload.accuracy : null,
      updatedAt: Date.now(),
    };

    vehicles.set(id, vehicle);
    socket.data.driverId = id;

    // Broadcast the update to every connected dispatcher.
    io.to("dispatchers").emit("vehicle:update", vehicle);
  });

  // When a driver explicitly stops sharing.
  socket.on("driver:stop", () => {
    const id = socket.data.driverId;
    if (id && vehicles.has(id)) {
      vehicles.delete(id);
      io.to("dispatchers").emit("vehicle:offline", { id });
    }
  });

  socket.on("disconnect", () => {
    const id = socket.data.driverId;
    if (id && vehicles.has(id)) {
      vehicles.delete(id);
      io.to("dispatchers").emit("vehicle:offline", { id });
    }
  });
});

httpServer.listen(PORT, () => {
  console.log(`\n  Fleet Tracker corriendo en http://localhost:${PORT}`);
  console.log(`  Panel de control:  http://localhost:${PORT}/`);
  console.log(`  App del repartidor: http://localhost:${PORT}/driver.html\n`);
});
