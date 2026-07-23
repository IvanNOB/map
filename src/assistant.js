import { createHash } from "crypto";
import { Router } from "express";
import config from "./config/index.js";
import logger from "./config/logger.js";
import { requireAuth, requireRole } from "./auth.js";
import { askOpenAI, OpenAIServiceError } from "./services/openai.js";

const router = Router();
const requestBuckets = new Map();
const ORDER_STATUSES = new Set(["pending", "assigned", "picked_up", "on_the_way", "delivered", "cancelled"]);
const DRIVER_STATUSES = new Set(["available", "busy", "offline"]);

function assistantRateLimit(req, res, next) {
  const key = `${req.user?.id || "anonymous"}:${req.ip || "unknown"}`;
  const now = Date.now();
  let bucket = requestBuckets.get(key);
  if (!bucket || now - bucket.startedAt >= config.assistantRateLimitWindowMs) {
    bucket = { count: 0, startedAt: now };
    requestBuckets.set(key, bucket);
  }
  bucket.count += 1;

  const remaining = Math.max(0, config.assistantRateLimitMax - bucket.count);
  res.setHeader("X-Assistant-RateLimit-Limit", config.assistantRateLimitMax);
  res.setHeader("X-Assistant-RateLimit-Remaining", remaining);

  if (bucket.count > config.assistantRateLimitMax) {
    const retrySeconds = Math.ceil((config.assistantRateLimitWindowMs - (now - bucket.startedAt)) / 1000);
    res.setHeader("Retry-After", Math.max(1, retrySeconds));
    return res.status(429).json({ error: "Has realizado demasiadas consultas. Espera un momento." });
  }
  next();
}

function cleanText(value, maxLength = 80) {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function redactQuestion(value) {
  return cleanText(value, 500)
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[correo omitido]")
    .replace(/\b(?:\+?\d[\s().-]*)?(?:\d[\s().-]*){7,14}\b/g, "[teléfono omitido]");
}

function safeNumber(value, min, max, fallback = 0) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function normalizeNearest(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 3).map((item) => ({
    name: cleanText(item?.name, 60),
    distance_km: safeNumber(item?.distance_km, 0, 500),
  })).filter((item) => item.name);
}

function normalizeOrders(value) {
  if (!Array.isArray(value)) return [];
  return value.map((order) => ({
    code: cleanText(order?.code, 30),
    status: ORDER_STATUSES.has(order?.status) ? order.status : "unknown",
    assigned_to: cleanText(order?.assigned_to, 60) || null,
    age_minutes: Math.round(safeNumber(order?.age_minutes, 0, 10080)),
    estimated_minutes: Math.round(safeNumber(order?.estimated_minutes, 0, 1440)),
    amount: Math.round(safeNumber(order?.amount, 0, 100000000)),
    scheduled: Boolean(order?.scheduled),
    nearest_available: normalizeNearest(order?.nearest_available),
  })).filter((order) => order.code);
}

function normalizeDrivers(value) {
  if (!Array.isArray(value)) return [];
  return value.map((driver) => ({
    name: cleanText(driver?.name, 60),
    status: DRIVER_STATUSES.has(driver?.status) ? driver.status : "offline",
    last_seen_minutes: Math.round(safeNumber(driver?.last_seen_minutes, 0, 10080)),
    speed_kmh: Math.round(safeNumber(driver?.speed_kmh, 0, 250)),
    deliveries_today: Math.round(safeNumber(driver?.deliveries_today, 0, 500)),
    active_orders: Math.round(safeNumber(driver?.active_orders, 0, 100)),
  })).filter((driver) => driver.name);
}

function normalizeContext(rawContext) {
  const allOrders = normalizeOrders(rawContext?.orders);
  const allDrivers = normalizeDrivers(rawContext?.drivers);
  const activeStatuses = new Set(["pending", "assigned", "picked_up", "on_the_way"]);
  const driverPriority = { available: 0, busy: 1, offline: 2 };

  const selectedOrders = [...allOrders]
    .sort((a, b) => {
      const activeDifference = Number(!activeStatuses.has(a.status)) - Number(!activeStatuses.has(b.status));
      return activeDifference || b.age_minutes - a.age_minutes;
    })
    .slice(0, 80);
  const selectedDrivers = [...allDrivers]
    .sort((a, b) => driverPriority[a.status] - driverPriority[b.status] || a.last_seen_minutes - b.last_seen_minutes)
    .slice(0, 50);

  const driverAliases = new Map();
  for (const driver of selectedDrivers) {
    if (!driverAliases.has(driver.name)) {
      driverAliases.set(driver.name, `Repartidor ${driverAliases.size + 1}`);
    }
  }
  const aliasPairs = [];
  const restoredDriverAliases = new Set();
  const drivers = selectedDrivers.map((driver) => {
    const alias = driverAliases.get(driver.name);
    if (!restoredDriverAliases.has(alias)) {
      aliasPairs.push([alias, driver.name]);
      restoredDriverAliases.add(alias);
    }
    return { ...driver, name: alias };
  });
  const orders = selectedOrders.map((order, index) => {
    const alias = `Pedido ${index + 1}`;
    aliasPairs.push([alias, order.code]);
    return {
      ...order,
      code: alias,
      assigned_to: driverAliases.get(order.assigned_to) || null,
      nearest_available: order.nearest_available
        .map((driver) => ({ ...driver, name: driverAliases.get(driver.name) }))
        .filter((driver) => driver.name),
    };
  });

  const statusCounts = {};
  for (const order of allOrders) statusCounts[order.status] = (statusCounts[order.status] || 0) + 1;

  return {
    context: {
      generated_at: new Date().toISOString(),
      timezone: config.timezone,
      summary: {
        total_orders: allOrders.length,
        analyzed_orders: orders.length,
        orders_truncated: allOrders.length > orders.length,
        total_drivers: allDrivers.length,
        analyzed_drivers: drivers.length,
        drivers_truncated: allDrivers.length > drivers.length,
        available_drivers: allDrivers.filter((driver) => driver.status === "available").length,
        busy_drivers: allDrivers.filter((driver) => driver.status === "busy").length,
        offline_drivers: allDrivers.filter((driver) => driver.status === "offline").length,
        orders_by_status: statusCounts,
      },
      orders,
      drivers,
    },
    aliasPairs,
  };
}

function restoreAliases(answer, aliasPairs) {
  return [...aliasPairs]
    .sort((a, b) => b[0].length - a[0].length)
    .reduce((text, [alias, display]) => text.split(alias).join(display), answer);
}

function safetyIdentifier(userId) {
  return createHash("sha256").update(`servicio-ghost:${userId}`).digest("hex").slice(0, 64);
}

router.get("/status", requireAuth, requireRole("admin"), (req, res) => {
  res.json({
    configured: Boolean(config.openaiApiKey),
    model: config.openaiModel,
    read_only: true,
  });
});

router.post("/consult", requireAuth, requireRole("admin"), assistantRateLimit, async (req, res) => {
  const question = redactQuestion(req.body?.question);
  if (!question || question.length < 3) {
    return res.status(400).json({ error: "Escribe una pregunta de al menos 3 caracteres" });
  }

  const normalized = normalizeContext(req.body?.context);
  if (!normalized.context.orders.length && !normalized.context.drivers.length) {
    return res.status(400).json({ error: "No hay datos operativos disponibles para analizar" });
  }

  try {
    const result = await askOpenAI({
      question,
      context: normalized.context,
      safetyIdentifier: safetyIdentifier(req.user.id),
    });
    return res.json({
      answer: restoreAliases(result.answer, normalized.aliasPairs),
      model: result.model,
      read_only: true,
      generated_at: new Date().toISOString(),
    });
  } catch (error) {
    if (error instanceof OpenAIServiceError) {
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    logger.error("Unexpected assistant error", {
      error: error?.message || "unknown",
      user_id: req.user.id,
    });
    return res.status(500).json({ error: "El asistente no pudo completar la consulta" });
  }
});

const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of requestBuckets) {
    if (now - bucket.startedAt >= config.assistantRateLimitWindowMs) requestBuckets.delete(key);
  }
}, Math.max(30_000, config.assistantRateLimitWindowMs));
cleanupTimer.unref?.();

export default router;
