/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Agencia de Domicilios — Main Server
 * 
 * Thin orchestrator that wires together:
 * - Express app with middleware
 * - API routes (controllers)
 * - Socket.IO real-time handlers
 * - Scheduled cron jobs
 * ═══════════════════════════════════════════════════════════════════════════
 */
import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cookieParser from "cookie-parser";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

// ─── Config & Infrastructure ─────────────────────────────────────────────────
import config from "./src/config/index.js";
import logger from "./src/config/logger.js";
import metrics from "./src/config/metrics.js";
import db, { init, isPostgres } from "./db/database.js";

// ─── Middleware ──────────────────────────────────────────────────────────────
import { cors, securityHeaders, rateLimit } from "./src/middleware/security.js";
import { sanitizeBody } from "./src/middleware/sanitize.js";

// ─── Routes (Controllers) ───────────────────────────────────────────────────
import authRouter from "./src/auth.js";
import driversRouter from "./src/drivers.js";
import createOrdersRouter from "./src/orders.js";
import createLocationRouter from "./src/location.js";
import trackingRouter from "./src/tracking.js";
import reportsRouter from "./src/reports.js";
import chatRouter from "./src/chat.js";
import contactsRouter from "./src/contacts.js";
import customersRouter from "./src/customers.js";
import settingsRouter from "./src/settings.js";
import activityRouter from "./src/activity.js";
import zonesRouter from "./src/zones.js";
import pushRouter, { initPush } from "./src/push.js";
import branchesRouter from "./src/branches.js";
import placesRouter from "./src/places.js";
import restaurantsRouter from "./src/restaurants.js";
import assistantRouter from "./src/assistant.js";
import clientMemoryRouter, { initClientMemory } from "./src/ghosty/client-memory.js";
import whatsappCloudRouter from "./src/ghosty/whatsapp-cloud.js";

// ─── Socket & Cron ──────────────────────────────────────────────────────────
import { setupSocketHandlers } from "./src/socket/handler.js";
import { startCronJobs } from "./src/cron-jobs.js";

// ═══════════════════════════════════════════════════════════════════════════════

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: { origin: config.corsOrigin, credentials: true },
});

// ─── Global Middleware ───────────────────────────────────────────────────────

app.set("trust proxy", 1);
app.use(cors);
app.use(securityHeaders);
app.use(metrics.httpMiddleware());
app.use(logger.requestLogger);
app.use(express.json({
  limit: "2mb",
  verify: (req, _res, buf) => {
    // Store raw body for webhook signature verification
    if (req.url && req.url.includes("/ghosty/whatsapp/webhook")) {
      req.rawBody = buf.toString("utf8");
    }
  },
}));
app.use(sanitizeBody);
app.use(cookieParser());
app.use(express.static(join(__dirname, "public")));
app.set("io", io);

// ─── API Routes ──────────────────────────────────────────────────────────────

// Auth (stricter rate limit handled internally)
app.use("/api/auth", authRouter);

// All other API routes with global rate limit
app.use("/api/", rateLimit);

app.use("/api/drivers", driversRouter);

const ordersRouter = createOrdersRouter(io);
app.use("/api/orders", ordersRouter);
app.use("/api/stats", (req, res, next) => { req.url = "/stats"; ordersRouter(req, res, next); });

app.use("/api/location", createLocationRouter(io));
app.use("/api/track", trackingRouter);
app.use("/api/reports", reportsRouter);
app.use("/api/chat", chatRouter);
app.use("/api/contacts", contactsRouter);
app.use("/api/customers", customersRouter);
app.use("/api/settings", settingsRouter);
app.use("/api/activity", activityRouter);
app.use("/api/zones", zonesRouter);
app.use("/api/push", pushRouter);
app.use("/api/branches", branchesRouter);
app.use("/api/places", placesRouter);
app.use("/api/restaurants", restaurantsRouter);
app.use("/api/assistant", assistantRouter);
app.use("/api/ghosty/clients", clientMemoryRouter);
app.use("/api/ghosty/whatsapp", whatsappCloudRouter);

// ─── Health Check ────────────────────────────────────────────────────────────

app.get("/api/health", async (req, res) => {
  const uptime = process.uptime();
  const mem = process.memoryUsage();
  let dbStatus = "unknown";
  let dbLatency = 0;
  try {
    const start = Date.now();
    await db.get("SELECT 1 as ok");
    dbLatency = Date.now() - start;
    dbStatus = "connected";
  } catch { dbStatus = "error"; }

  res.json({
    status: dbStatus === "connected" ? "healthy" : "degraded",
    uptime: Math.round(uptime),
    uptime_human: `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`,
    database: { type: isPostgres ? "postgresql" : "sqlite", status: dbStatus, latency_ms: dbLatency },
    memory: { rss_mb: Math.round(mem.rss / 1024 / 1024), heap_mb: Math.round(mem.heapUsed / 1024 / 1024) },
    connections: { websocket: metrics.getMetrics().socket.active_connections },
    redis: config.redisEnabled ? "configured" : "not_configured",
    timestamp: new Date().toISOString(),
  });
});

// ─── Metrics Endpoint ────────────────────────────────────────────────────────

app.get("/api/metrics", (req, res) => {
  // Support Prometheus format via Accept header
  if (req.headers.accept && req.headers.accept.includes("text/plain")) {
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    return res.send(metrics.getPrometheusMetrics());
  }
  res.json(metrics.getMetrics());
});

// ─── Socket.IO ───────────────────────────────────────────────────────────────

setupSocketHandlers(io);

// ─── Start ───────────────────────────────────────────────────────────────────

await init();
await initClientMemory();
await initPush();
startCronJobs(io);

httpServer.listen(config.port, () => {
  logger.info("Server started", {
    port: config.port,
    database: isPostgres ? "PostgreSQL" : "SQLite",
    redis: config.redisEnabled ? "enabled" : "disabled",
    env: config.nodeEnv,
  });
  logger.info(`Panel:      http://localhost:${config.port}/`);
  logger.info(`Repartidor: http://localhost:${config.port}/driver.html`);
  logger.info(`Health:     http://localhost:${config.port}/api/health`);
});
