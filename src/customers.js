import { Router } from "express";
import db from "../db/database.js";
import { requireAuth, requireRole } from "./auth.js";

const router = Router();

// GET /api/customers - distinct customers derived from past orders (admin only)
// Returns the most recent phone + addresses per customer name, for autocomplete.
router.get("/", requireAuth, requireRole("admin"), async (req, res) => {
  const rows = await db.all(
    `SELECT customer_name, customer_phone, pickup_address, dropoff_address, created_at
     FROM orders
     WHERE customer_name IS NOT NULL AND customer_name <> ''
     ORDER BY created_at DESC
     LIMIT 1000`
  );

  // Deduplicate by lowercased name, keeping the most recent (rows are DESC).
  const seen = new Set();
  const customers = [];
  for (const r of rows) {
    const key = r.customer_name.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    customers.push({
      name: r.customer_name,
      phone: r.customer_phone || "",
      last_pickup: r.pickup_address || "",
      last_dropoff: r.dropoff_address || "",
    });
  }

  res.json(customers);
});

export default router;
