import { Router } from "express";
import PDFDocument from "pdfkit";
import db from "../db/database.js";
import { requireAuth, requireRole } from "./auth.js";

const router = Router();

// ─── GET /api/reports/orders?format=csv|pdf&from=DATE&to=DATE ──────────────

router.get("/orders", requireAuth, requireRole("admin"), (req, res) => {
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

  const orders = db.prepare(query).all(...params);

  if (format === "pdf") {
    return generatePDF(res, orders, from, to);
  }

  // Default: CSV
  generateCSV(res, orders);
});

// ─── GET /api/reports/summary?from=DATE&to=DATE ─────────────────────────────

router.get("/summary", requireAuth, requireRole("admin"), (req, res) => {
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

  const totalOrders = db
    .prepare(`SELECT COUNT(*) as count FROM orders ${whereClause}`)
    .get(...params).count;

  const totalRevenue = db
    .prepare(
      `SELECT COALESCE(SUM(amount), 0) as total FROM orders ${whereClause} AND status = 'delivered'`
    )
    .get(...params).total;

  const avgDeliveryMinutes = db
    .prepare(
      `SELECT AVG(
        (julianday(delivered_at) - julianday(assigned_at)) * 24 * 60
      ) as avg_minutes
      FROM orders ${whereClause} AND status = 'delivered' AND delivered_at IS NOT NULL AND assigned_at IS NOT NULL`
    )
    .get(...params).avg_minutes;

  // Orders by status
  const statusRows = db
    .prepare(
      `SELECT status, COUNT(*) as count FROM orders ${whereClause} GROUP BY status`
    )
    .all(...params);

  const ordersByStatus = {};
  for (const row of statusRows) {
    ordersByStatus[row.status] = row.count;
  }

  res.json({
    total_orders: totalOrders,
    total_revenue: totalRevenue,
    avg_delivery_minutes: avgDeliveryMinutes ? Math.round(avgDeliveryMinutes * 10) / 10 : null,
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

export default router;
