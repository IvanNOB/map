/**
 * Integración con Servicios Ghost (tienda en GitHub Pages + Supabase).
 *
 * Cuando un cliente hace un pedido en Servicios Ghost, Supabase llama a:
 *   POST /api/integraciones/ghost      (cabecera  x-ghost-secret: <secreto>)
 *   cuerpo: { "record": <fila de la tabla pedidos de Supabase> }
 *
 * Por cada restaurante del pedido se crea una orden "pending" en map, con el
 * mismo código de Ghost (GH-XXXXXX, o GH-XXXXXX-2 si hay varios negocios), y se
 * avisa a los domiciliarios para que la acepten, igual que una orden normal.
 *
 * - Sin la variable GHOST_WEBHOOK_SECRET la integración queda apagada.
 * - Es idempotente: si el aviso llega dos veces, no se duplica la orden.
 */
import { Router } from "express";
import { timingSafeEqual } from "crypto";
import db from "../db/database.js";
import logger from "./config/logger.js";
import { haversineDistance, estimateTime, getRoute } from "./utils.js";
import { notifyAdmins } from "./notifications.js";
import { logActivity } from "./activity.js";
import { sendPush } from "./push.js";
import { getDeliveryFare } from "./services/pricing.js";

const ACTOR = { id: null, name: "Servicios Ghost", role: "integracion" };
const CODIGO_RE = /^GH-[A-Z0-9]{5,10}$/;

function secretoValido(recibido) {
  const esperado = process.env.GHOST_WEBHOOK_SECRET || "";
  if (!esperado || typeof recibido !== "string") return false;
  const a = Buffer.from(recibido);
  const b = Buffer.from(esperado);
  return a.length === b.length && timingSafeEqual(a, b);
}

const txt = (v, max = 200) => (v == null ? "" : String(v).replace(/<[^>]*>/g, "").trim().slice(0, max));
const money = (n) => "$" + Math.round(Number(n) || 0).toLocaleString("es-CO");
const normalizar = (s) =>
  String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

function normalizePhone(raw) {
  let d = String(raw || "").replace(/\D/g, "");
  if (!d) return null;
  if (d.length === 12 && d.startsWith("57")) d = d.slice(2);
  if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
  return "+57" + d;
}

function coordsValidas(u) {
  return u && typeof u.lat === "number" && typeof u.lng === "number" &&
    Number.isFinite(u.lat) && Number.isFinite(u.lng) && Math.abs(u.lat) <= 90 && Math.abs(u.lng) <= 180;
}

// Busca el negocio de Ghost en map por nombre: primero restaurantes con cuenta,
// después lugares guardados. Devuelve dirección y coordenadas de recogida.
async function buscarRecogida(nombre) {
  const n = normalizar(nombre);
  if (!n) return null;
  const parecido = (otro) => {
    const o = normalizar(otro);
    return o && (o === n || (o.length >= 4 && n.includes(o)) || (n.length >= 4 && o.includes(n)));
  };
  try {
    const rests = await db.all(
      `SELECT u.id, u.name, r.address, r.lat, r.lng FROM users u JOIN restaurants r ON r.user_id = u.id WHERE u.role = 'restaurant'`
    );
    const r = rests.find((x) => normalizar(x.name) === n) || rests.find((x) => parecido(x.name));
    if (r) return { restaurant_id: r.id, address: r.address || r.name, lat: r.lat, lng: r.lng };
  } catch (e) { logger.warn("ghost: no se pudo leer restaurantes", { error: e?.message }); }
  try {
    const places = await db.all("SELECT name, address, lat, lng FROM places");
    const p = places.find((x) => normalizar(x.name) === n) || places.find((x) => parecido(x.name));
    if (p) return { restaurant_id: null, address: p.address || p.name, lat: p.lat, lng: p.lng };
  } catch (e) { logger.warn("ghost: no se pudo leer lugares", { error: e?.message }); }
  return null;
}

// Agrupa los productos del pedido por restaurante.
function porRestaurante(items) {
  const grupos = new Map();
  for (const it of Array.isArray(items) ? items.slice(0, 80) : []) {
    if (!it || typeof it !== "object") continue;
    const clave = txt(it.restaurante_id || it.restaurante || "ghost", 80);
    if (!grupos.has(clave)) grupos.set(clave, { nombre: txt(it.restaurante || clave, 120), items: [] });
    grupos.get(clave).items.push(it);
  }
  return [...grupos.values()];
}

function lineasProductos(items) {
  return items.map((it) => {
    const cant = Math.max(1, Math.min(999, parseInt(it.cantidad, 10) || 1));
    let l = `${cant}x ${txt(it.plato, 160)}`;
    if (Number(it.subtotal) > 0) l += ` (${money(it.subtotal)})`;
    if (it.nota) l += `\n   - Nota: ${txt(it.nota, 200)}`;
    const tarjetas = Array.isArray(it.tarjeta) ? it.tarjeta : it.tarjeta ? [it.tarjeta] : [];
    for (const t of tarjetas.slice(0, 20)) {
      if (!t || !t.msg) continue;
      l += `\n   - Mensaje en vaso/tarjeta${t.u ? " #" + txt(t.u, 4) : ""}: "${txt(t.msg, 500)}"` +
        (t.para ? ` (para ${txt(t.para, 60)})` : "") + (t.de ? ` (de ${txt(t.de, 60)})` : "");
    }
    return l;
  }).join("\n");
}

/** Convierte un pedido de Ghost en las órdenes de map (una por restaurante). */
export function ordenesDesdePedido(record) {
  const codigo = txt(record?.codigo, 20).toUpperCase();
  if (!CODIGO_RE.test(codigo)) throw new Error("Código de pedido inválido");
  const c = record.cliente && typeof record.cliente === "object" ? record.cliente : {};
  const regalo = c.modo === "regalo" && c.destinatario && typeof c.destinatario === "object";
  const d = regalo ? c.destinatario : null;
  const grupos = porRestaurante(record.items);
  if (!grupos.length) throw new Error("El pedido no tiene productos");

  const ubic = !regalo && coordsValidas(c.ubicacion) ? c.ubicacion : null;
  const dropoff = regalo
    ? txt(d.referencia, 200) || "Confirmar dirección con quien recibe"
    : [txt(c.direccion, 200), txt(c.barrio, 80)].filter(Boolean).join(", ") || "Confirmar dirección por WhatsApp";

  return grupos.map((g, i) => {
    const subtotal = g.items.reduce((s, it) => s + (Number(it.subtotal) || 0), 0);
    const notas = [];
    notas.push(`Pedido de Servicios Ghost ${codigo}` + (grupos.length > 1 ? ` (parte ${i + 1} de ${grupos.length})` : ""));
    if (regalo) {
      notas.push(`ES UN REGALO. Compra: ${txt(c.nombre, 80)} · ${txt(c.telefono, 20)}`);
      notas.push("Escribirle a quien recibe para confirmar la dirección.");
    }
    notas.push(`Cobrar productos: ${money(subtotal)}` + (c.pago ? ` · Pago: ${txt(c.pago, 30)}` : ""));
    if (ubic) notas.push(`Ubicación del cliente: https://maps.google.com/?q=${ubic.lat},${ubic.lng}`);
    if (c.notas) notas.push(`Nota: ${txt(c.notas, 300)}`);
    return {
      code: grupos.length > 1 ? `${codigo}-${i + 1}` : codigo,
      restaurante: g.nombre,
      customer_name: regalo ? txt(d.nombre, 80) || "Quien recibe" : txt(c.nombre, 80) || "Cliente",
      customer_phone: normalizePhone(regalo ? d.telefono : c.telefono),
      dropoff_address: dropoff,
      dropoff_lat: ubic ? ubic.lat : null,
      dropoff_lng: ubic ? ubic.lng : null,
      items: lineasProductos(g.items).slice(0, 4000),
      notes: notas.join("\n").slice(0, 2000),
      amount: typeof c.domicilio === "number" && c.domicilio >= 0 && i === 0 ? c.domicilio : null,
      payment_method: /transfer/i.test(String(c.pago || "")) ? "card" : "cash",
    };
  });
}

async function crearOrden(io, o) {
  const existe = await db.get("SELECT * FROM orders WHERE code = ?", [o.code]);
  if (existe) return { order: existe, nueva: false };

  const recogida = await buscarRecogida(o.restaurante);
  const pickup_address = recogida?.address || o.restaurante || "Servicios Ghost";
  const pickup_lat = recogida?.lat ?? null;
  const pickup_lng = recogida?.lng ?? null;

  let info;
  try {
    info = await db.run(
      `INSERT INTO orders (code, customer_name, customer_phone, pickup_address, pickup_lat, pickup_lng,
                           dropoff_address, dropoff_lat, dropoff_lng, items, notes, amount, payment_method)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [o.code, o.customer_name, o.customer_phone, pickup_address, pickup_lat, pickup_lng,
       o.dropoff_address, o.dropoff_lat, o.dropoff_lng, o.items, o.notes,
       o.amount ?? getDeliveryFare(), o.payment_method]
    );
  } catch (err) {
    const dup = err.code === "23505" || /unique|duplicate/i.test(err.message || "");
    if (dup) return { order: await db.get("SELECT * FROM orders WHERE code = ?", [o.code]), nueva: false };
    throw err;
  }
  let order = await db.get("SELECT * FROM orders WHERE id = ?", [info.lastInsertRowid]);

  if (recogida?.restaurant_id) {
    await db.run("UPDATE orders SET restaurant_id = ? WHERE id = ?", [recogida.restaurant_id, order.id]);
  }
  if (pickup_lat && pickup_lng && o.dropoff_lat && o.dropoff_lng) {
    const ruta = await getRoute(pickup_lat, pickup_lng, o.dropoff_lat, o.dropoff_lng).catch(() => null);
    const km = ruta ? ruta.distanceKm : haversineDistance(pickup_lat, pickup_lng, o.dropoff_lat, o.dropoff_lng);
    const min = ruta ? ruta.minutes : estimateTime(km);
    await db.run("UPDATE orders SET estimated_distance_km = ?, estimated_minutes = ? WHERE id = ?",
      [Math.round(km * 100) / 100, Math.round(min * 10) / 10, order.id]);
  }
  order = await db.get("SELECT * FROM orders WHERE id = ?", [order.id]);

  // Los mismos avisos que una orden creada en el panel.
  io.to("admins").emit("order:new", order);
  notifyAdmins(io, "order_new", order);
  logActivity(ACTOR, "order_created", "Pedido " + order.code + " recibido de Servicios Ghost");
  io.to("drivers").emit("order:available", order);
  if (order.restaurant_id) io.to(`restaurant:${order.restaurant_id}`).emit("order:new", order);
  db.all("SELECT id FROM users WHERE role = 'admin'").then((admins) => {
    admins.forEach((a) => sendPush(a.id, { title: "Nuevo pedido (Servicios Ghost)", body: order.code + " - " + order.customer_name, url: "/" }));
  }).catch(() => {});
  db.all("SELECT user_id as id FROM drivers WHERE status = 'available'").then((ds) => {
    ds.forEach((d) => sendPush(d.id, { title: "Nuevo pedido disponible!", body: order.code + " - " + (order.dropoff_address || "Aceptar para ver detalles"), url: "/driver.html" }));
  }).catch(() => {});

  return { order, nueva: true };
}

export default function createGhostIntegrationRouter(io) {
  const router = Router();

  router.get("/ghost", (req, res) => {
    res.json({ ok: true, activa: !!process.env.GHOST_WEBHOOK_SECRET });
  });

  router.post("/ghost", async (req, res) => {
    if (!process.env.GHOST_WEBHOOK_SECRET) return res.status(503).json({ error: "Integración con Servicios Ghost apagada" });
    if (!secretoValido(req.get("x-ghost-secret"))) return res.status(401).json({ error: "No autorizado" });

    const record = req.body && (req.body.record || req.body);
    let ordenes;
    try {
      ordenes = ordenesDesdePedido(record);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
    if (record.estado === "cancelado") return res.json({ ok: true, ignorado: "cancelado" });

    try {
      const out = [];
      for (const o of ordenes) {
        const r = await crearOrden(io, o);
        out.push({ code: r.order?.code, id: r.order?.id, nueva: r.nueva });
      }
      logger.info("ghost: pedido recibido", { codigo: record.codigo, ordenes: out.length });
      res.status(201).json({ ok: true, ordenes: out });
    } catch (e) {
      logger.error("ghost: error creando orden", { error: e?.message });
      res.status(500).json({ error: "Error al crear la orden" });
    }
  });

  return router;
}
