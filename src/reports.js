import { Router } from "express";
import PDFDocument from "pdfkit";
import db, { COUNT_INT } from "../db/database.js";
import { requireAuth, requireRole } from "./auth.js";
import { getSettingsMap } from "./settings.js";

const router = Router();

// date(col) = ?  vs  col::date = ?::date
const dateEq = (col) => (db.isPostgres ? `${col}::date = ?::date` : `date(${col}) = ?`);

// ─── GET /api/reports/dashboard - advanced stats (admin) ────────────────────
router.get("/dashboard", requireAuth, requireRole("admin"), async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);

  // Orders per hour (today)
  const hourExpr = db.isPostgres
    ? "EXTRACT(HOUR FROM created_at)::int"
    : "CAST(strftime('%H', created_at) AS INTEGER)";
  const hourRows = await db.all(
    `SELECT ${hourExpr} AS hour, ${COUNT_INT} AS count
     FROM orders WHERE ${dateEq("created_at")}
     GROUP BY ${hourExpr} ORDER BY hour`,
    [today]
  );
  const ordersByHour = Array(24).fill(0);
  for (const r of hourRows) {
    const h = Number(r.hour);
    if (h >= 0 && h < 24) ordersByHour[h] = Number(r.count);
  }

  // Driver ranking (by deliveries, all time)
  const ranking = await db.all(
    `SELECT u.name,
            (SELECT ${COUNT_INT} FROM orders o WHERE o.driver_id = u.id AND o.status = 'delivered') AS deliveries,
            (SELECT ROUND(AVG(rating), 1) FROM orders o WHERE o.driver_id = u.id AND o.rating IS NOT NULL) AS avg_rating
     FROM users u WHERE u.role = 'driver'
     ORDER BY deliveries DESC`
  );

  res.json({
    orders_by_hour: ordersByHour,
    driver_ranking: ranking.map((r) => ({
      name: r.name,
      deliveries: Number(r.deliveries) || 0,
      avg_rating: r.avg_rating != null ? Number(r.avg_rating) : null,
    })),
  });
});

// ─── GET /api/reports/cash?date=YYYY-MM-DD ── daily cash reconciliation (admin)
router.get("/cash", requireAuth, requireRole("admin"), async (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  const settings = await getSettingsMap();
  const pct = Number(settings.driver_commission_pct) || 0;

  const rows = await db.all(
    `SELECT COALESCE(u.name, 'Sin asignar') AS driver_name, o.driver_id,
            o.amount, o.payment_method
     FROM orders o
     LEFT JOIN users u ON u.id = o.driver_id
     WHERE o.status = 'delivered' AND ${dateEq("o.delivered_at")}`,
    [date]
  );

  const byDriver = {};
  for (const r of rows) {
    const key = r.driver_id || 0;
    if (!byDriver[key]) {
      byDriver[key] = {
        driver_id: r.driver_id, driver_name: r.driver_name,
        deliveries: 0, total: 0, cash: 0, card: 0, driver_earning: 0, agency_earning: 0,
      };
    }
    const amt = Number(r.amount) || 0;
    const b = byDriver[key];
    b.deliveries += 1;
    b.total += amt;
    if (r.payment_method === "cash") b.cash += amt; else b.card += amt;
    b.driver_earning += amt * pct / 100;
    b.agency_earning += amt * (100 - pct) / 100;
  }

  const drivers = Object.values(byDriver).map((b) => ({
    ...b,
    total: Math.round(b.total),
    cash: Math.round(b.cash),
    card: Math.round(b.card),
    driver_earning: Math.round(b.driver_earning),
    agency_earning: Math.round(b.agency_earning),
  }));

  const totals = drivers.reduce((t, b) => ({
    deliveries: t.deliveries + b.deliveries,
    total: t.total + b.total,
    cash: t.cash + b.cash,
    card: t.card + b.card,
    driver_earning: t.driver_earning + b.driver_earning,
    agency_earning: t.agency_earning + b.agency_earning,
  }), { deliveries: 0, total: 0, cash: 0, card: 0, driver_earning: 0, agency_earning: 0 });

  res.json({ date, commission_pct: pct, drivers, totals });
});

// ─── GET /api/reports/my-earnings?from=&to=  (driver: own earnings) ─────────
router.get("/my-earnings", requireAuth, async (req, res) => {
  if (req.user.role !== "driver") return res.status(403).json({ error: "Solo repartidores" });
  const settings = await getSettingsMap();
  const pct = Number(settings.driver_commission_pct) || 0;

  const { from, to } = req.query;
  let where = "WHERE status = 'delivered' AND driver_id = ?";
  const params = [req.user.id];
  if (from) { where += " AND delivered_at >= ?"; params.push(from); }
  if (to) { where += " AND delivered_at <= ?"; params.push(to + " 23:59:59"); }

  const agg = await db.get(
    `SELECT ${COUNT_INT} AS deliveries, COALESCE(SUM(amount), 0) AS total FROM orders ${where}`,
    params
  );
  const total = Number(agg.total) || 0;
  res.json({
    deliveries: Number(agg.deliveries) || 0,
    total: Math.round(total),
    earning: Math.round(total * pct / 100),
    commission_pct: pct,
  });
});

// ─── GET /api/reports/orders?format=csv|pdf&from=DATE&to=DATE ──────────────

router.get("/orders", requireAuth, requireRole("admin"), async (req, res) => {
  const { format = "csv", from, to } = req.query;

  let query = `
    SELECT o.code, o.customer_name, COALESCE(u.name, 'Sin asignar') as driver_name,
           o.status, o.amount, o.payment_method, o.created_at, o.delivered_at
    FROM orders o
    LEFT JOIN users u ON u.id = o.driver_id
    WHERE 1=1
  `;
  const params = [];

  if (from) {
    query += " AND o.created_at >= ?";
    params.push(from);
  }
  if (to) {
    query += " AND o.created_at <= ?";
    params.push(to + " 23:59:59");
  }

  query += " ORDER BY o.created_at DESC";

  const orders = await db.all(query, params);

  if (format === "pdf") {
    return generatePDF(res, orders, from, to);
  }

  // Default: CSV
  generateCSV(res, orders);
});

// ─── GET /api/reports/summary?from=DATE&to=DATE ─────────────────────────────

router.get("/summary", requireAuth, requireRole("admin"), async (req, res) => {
  const { from, to } = req.query;

  let whereClause = "WHERE 1=1";
  const params = [];

  if (from) {
    whereClause += " AND created_at >= ?";
    params.push(from);
  }
  if (to) {
    whereClause += " AND created_at <= ?";
    params.push(to + " 23:59:59");
  }

  const totalOrders = (
    await db.get(`SELECT ${COUNT_INT} as count FROM orders ${whereClause}`, params)
  ).count;

  const totalRevenue = (
    await db.get(
      `SELECT COALESCE(SUM(amount), 0) as total FROM orders ${whereClause} AND status = 'delivered'`,
      params
    )
  ).total;

  // Average delivery time in minutes (dialect-specific)
  const avgExpr = db.isPostgres
    ? "AVG(EXTRACT(EPOCH FROM (delivered_at - assigned_at)) / 60)"
    : "AVG((julianday(delivered_at) - julianday(assigned_at)) * 24 * 60)";

  const avgDeliveryMinutes = (
    await db.get(
      `SELECT ${avgExpr} as avg_minutes
       FROM orders ${whereClause} AND status = 'delivered' AND delivered_at IS NOT NULL AND assigned_at IS NOT NULL`,
      params
    )
  ).avg_minutes;

  // Orders by status
  const statusRows = await db.all(
    `SELECT status, ${COUNT_INT} as count FROM orders ${whereClause} GROUP BY status`,
    params
  );

  const ordersByStatus = {};
  for (const row of statusRows) {
    ordersByStatus[row.status] = Number(row.count);
  }

  res.json({
    total_orders: Number(totalOrders),
    total_revenue: Number(totalRevenue),
    avg_delivery_minutes: avgDeliveryMinutes ? Math.round(Number(avgDeliveryMinutes) * 10) / 10 : null,
    orders_by_status: ordersByStatus,
  });
});

// ─── Helper: Generate CSV ────────────────────────────────────────────────────

function generateCSV(res, orders) {
  const headers = [
    "Codigo",
    "Cliente",
    "Repartidor",
    "Estado",
    "Monto",
    "Metodo Pago",
    "Creado",
    "Entregado",
  ];

  const rows = orders.map((o) => [
    o.code,
    o.customer_name,
    o.driver_name,
    o.status,
    o.amount,
    o.payment_method,
    o.created_at,
    o.delivered_at || "",
  ]);

  const csv =
    headers.join(",") +
    "\n" +
    rows
      .map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","))
      .join("\n");

  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", "attachment; filename=reporte_ordenes.csv");
  res.send(csv);
}

// ─── Helper: Generate PDF ────────────────────────────────────────────────────

function generatePDF(res, orders, from, to) {
  const doc = new PDFDocument({ margin: 40, size: "A4" });

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", "attachment; filename=reporte_ordenes.pdf");
  doc.pipe(res);

  // Title
  doc.fontSize(18).text("Reporte de Ordenes", { align: "center" });
  doc.moveDown(0.5);

  // Date range
  const rangeText =
    from || to
      ? `Periodo: ${from || "inicio"} - ${to || "hoy"}`
      : "Periodo: Todas las ordenes";
  doc.fontSize(10).text(rangeText, { align: "center" });
  doc.moveDown(1);

  // Summary stats
  const totalOrders = orders.length;
  const totalRevenue = orders.reduce((sum, o) => sum + (o.amount || 0), 0);
  const delivered = orders.filter((o) => o.status === "delivered").length;

  doc.fontSize(11).text(`Total de ordenes: ${totalOrders}`);
  doc.text(`Ordenes entregadas: ${delivered}`);
  doc.text(`Ingresos totales: $${totalRevenue.toFixed(2)}`);
  doc.moveDown(1);

  // Table header
  const colWidths = [60, 80, 80, 70, 50, 70, 80];
  const headers = ["Codigo", "Cliente", "Repartidor", "Estado", "Monto", "Met. Pago", "Creado"];
  const startX = doc.x;

  doc.fontSize(8).font("Helvetica-Bold");
  let x = startX;
  headers.forEach((h, i) => {
    doc.text(h, x, doc.y, { width: colWidths[i], continued: i < headers.length - 1 });
    x += colWidths[i];
  });
  doc.moveDown(0.5);

  // Table rows
  doc.font("Helvetica").fontSize(7);
  for (const o of orders.slice(0, 50)) {
    // Limit to 50 rows in PDF to avoid overflow
    if (doc.y > 750) {
      doc.addPage();
    }
    x = startX;
    const row = [
      o.code,
      o.customer_name?.slice(0, 12) || "",
      o.driver_name?.slice(0, 12) || "",
      o.status,
      `$${(o.amount || 0).toFixed(2)}`,
      o.payment_method || "",
      o.created_at?.slice(0, 16) || "",
    ];
    const y = doc.y;
    row.forEach((val, i) => {
      doc.text(val, x, y, { width: colWidths[i] });
      x += colWidths[i];
    });
    doc.moveDown(0.3);
  }

  if (orders.length > 50) {
    doc.moveDown(0.5);
    doc.text(`... y ${orders.length - 50} ordenes mas.`);
  }

  doc.end();
}

// ─── POST /api/reports/save-cash-close ── auto-save daily cash close ─────────
router.post("/save-cash-close", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const date = (req.body && req.body.date) || new Date().toISOString().slice(0, 10);
    // Just acknowledge — the cash data is always available via GET /api/reports/cash?date=
    // This endpoint is called automatically at the start of each day to log the close
    const settings = await getSettingsMap();
    const pct = parseFloat(settings.driver_commission_pct || "80");
    const rows = await db.all(
      `SELECT ${COUNT_INT} as count, COALESCE(SUM(amount), 0) as total
       FROM orders WHERE ${dateEq("delivered_at")} AND status = 'delivered'`,
      [date]
    );
    const count = rows[0] ? rows[0].count : 0;
    const total = rows[0] ? Math.round(rows[0].total) : 0;
    // Log activity so there's a record
    if (count > 0) {
      const { logActivity } = await import("./activity.js");
      logActivity(req.user, "cash_close", `Cierre de caja ${date}: ${count} entregas, $${total} total`);
    }
    res.json({ ok: true, date, deliveries: count, total });
  } catch (e) {
    res.json({ ok: true, date: req.body && req.body.date, deliveries: 0, total: 0 });
  }
});

export default router;
