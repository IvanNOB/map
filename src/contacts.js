import { Router } from "express";
import db from "../db/database.js";
import { requireAuth, requireRole } from "./auth.js";

const router = Router();

// GET /api/contacts/seed-demo — insert demo contacts (admin only, one-time)
router.get("/seed-demo", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const existing = await db.get("SELECT COUNT(*) AS c FROM contacts");
    if (existing && Number(existing.c) > 0) {
      return res.json({ ok: true, message: "Ya hay contactos, no se insertan demos" });
    }
    // Labels
    await db.run("INSERT INTO contact_labels (name, color) VALUES (?, ?)", ["Clientes VIP", "#d4af37"]);
    await db.run("INSERT INTO contact_labels (name, color) VALUES (?, ?)", ["Restaurantes", "#22c55e"]);
    await db.run("INSERT INTO contact_labels (name, color) VALUES (?, ?)", ["Proveedores", "#3b82f6"]);
    await db.run("INSERT INTO contact_labels (name, color) VALUES (?, ?)", ["Repartidores", "#f97316"]);
    // Get label IDs
    const labels = await db.all("SELECT id, name FROM contact_labels ORDER BY id");
    const labelMap = {};
    for (const l of labels) labelMap[l.name] = l.id;

    const vip = labelMap["Clientes VIP"];
    const rest = labelMap["Restaurantes"];
    const prov = labelMap["Proveedores"];
    const rep = labelMap["Repartidores"];

    // Contacts
    await db.run("INSERT INTO contacts (name, phone, label_id, notes, lat, lng) VALUES (?, ?, ?, ?, ?, ?)", ["Diego Menco", "3214286626", vip, "Cliente frecuente", 4.6285, -74.0646]);
    await db.run("INSERT INTO contacts (name, phone, label_id, notes, lat, lng) VALUES (?, ?, ?, ?, ?, ?)", ["Valentina Ruiz", "3001234567", vip, "Paga con transferencia", 4.6350, -74.0700]);
    await db.run("INSERT INTO contacts (name, phone, label_id, notes, lat, lng) VALUES (?, ?, ?, ?, ?, ?)", ["Carlos Andres", "3109876543", vip, "Zona norte", 4.6500, -74.0550]);
    await db.run("INSERT INTO contacts (name, phone, label_id, notes, lat, lng) VALUES (?, ?, ?, ?, ?, ?)", ["Pizzeria Roma", "3205551234", rest, "Pedidos grandes los fines", 4.6200, -74.0800]);
    await db.run("INSERT INTO contacts (name, phone, label_id, notes, lat, lng) VALUES (?, ?, ?, ?, ?, ?)", ["El Sabor Criollo", "3107778899", rest, "Abre a las 11am", 4.6150, -74.0750]);
    await db.run("INSERT INTO contacts (name, phone, label_id, notes, lat, lng) VALUES (?, ?, ?, ?, ?, ?)", ["Sushi Express", "3023456789", rest, "Solo domingos", 4.6400, -74.0620]);
    await db.run("INSERT INTO contacts (name, phone, label_id, notes, lat, lng) VALUES (?, ?, ?, ?, ?, ?)", ["Distribuidor Bebidas", "3156667788", prov, "Mayorista", 4.6100, -74.0900]);
    await db.run("INSERT INTO contacts (name, phone, label_id, notes, lat, lng) VALUES (?, ?, ?, ?, ?, ?)", ["Papeleria Central", "3189990011", prov, "Entrega facturas lunes", 4.6250, -74.0680]);
    await db.run("INSERT INTO contacts (name, phone, label_id, notes, lat, lng) VALUES (?, ?, ?, ?, ?, ?)", ["Ivan Repartidor", "3214286626", rep, "Moto Honda CB190", 4.6300, -74.0650]);
    await db.run("INSERT INTO contacts (name, phone, label_id, notes, lat, lng) VALUES (?, ?, ?, ?, ?, ?)", ["Jean Carlos", "3001112233", rep, "Bicicleta", 4.6320, -74.0680]);
    await db.run("INSERT INTO contacts (name, phone, label_id, notes, lat, lng) VALUES (?, ?, ?, ?, ?, ?)", ["Kaleth", "3009998877", rep, "Moto AKT", 4.6280, -74.0720]);

    res.json({ ok: true, message: "12 contactos de prueba creados en 4 etiquetas" });
  } catch (err) {
    console.error("seed-demo error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Labels ───────────────────────────────────────────────────────────────────

// GET /api/contacts/labels — list all labels
router.get("/labels", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const rows = await db.all(
      "SELECT id, name, color, created_at FROM contact_labels ORDER BY name"
    );
    res.json(rows);
  } catch (err) {
    console.error("contacts: error listing labels", err.message);
    res.status(500).json({ error: "Error al obtener etiquetas" });
  }
});

// POST /api/contacts/labels — create a label
router.post("/labels", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const { name, color } = req.body || {};
    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: "El nombre es obligatorio" });
    }
    const trimmedName = String(name).trim();
    const labelColor = color && String(color).trim() ? String(color).trim() : "#d4af37";

    const info = await db.run(
      "INSERT INTO contact_labels (name, color) VALUES (?, ?)",
      [trimmedName, labelColor]
    );
    res.status(201).json({ id: info.lastInsertRowid, name: trimmedName, color: labelColor });
  } catch (err) {
    console.error("contacts: error creating label", err.message);
    res.status(500).json({ error: "Error al crear etiqueta" });
  }
});

// DELETE /api/contacts/labels/:id — delete a label
router.delete("/labels/:id", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await db.get("SELECT id FROM contact_labels WHERE id = ?", [id]);
    if (!existing) {
      return res.status(404).json({ error: "Etiqueta no encontrada" });
    }
    await db.run("DELETE FROM contact_labels WHERE id = ?", [id]);
    res.json({ ok: true });
  } catch (err) {
    console.error("contacts: error deleting label", err.message);
    res.status(500).json({ error: "Error al eliminar etiqueta" });
  }
});

// ─── Contacts ─────────────────────────────────────────────────────────────────

// GET /api/contacts — list all contacts (optionally filter by ?label=ID)
router.get("/", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const { label } = req.query;
    let query = `
      SELECT c.id, c.name, c.phone, c.label_id, c.notes, c.lat, c.lng, c.created_at,
             cl.name AS label_name, cl.color AS label_color
      FROM contacts c
      LEFT JOIN contact_labels cl ON cl.id = c.label_id
    `;
    const params = [];

    if (label) {
      query += " WHERE c.label_id = ?";
      params.push(label);
    }

    query += " ORDER BY c.name";

    const rows = await db.all(query, params);
    res.json(rows);
  } catch (err) {
    console.error("contacts: error listing contacts", err.message);
    res.status(500).json({ error: "Error al obtener contactos" });
  }
});

// POST /api/contacts — create a contact
router.post("/", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const { name, phone, label_id, notes, lat, lng } = req.body || {};
    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: "El nombre es obligatorio" });
    }
    if (!phone || !String(phone).trim()) {
      return res.status(400).json({ error: "El teléfono es obligatorio" });
    }

    const trimmedName = String(name).trim();
    const trimmedPhone = String(phone).trim();
    const contactNotes = notes ? String(notes).trim() : null;
    const contactLabelId = label_id || null;
    const contactLat = lat != null && !isNaN(lat) ? parseFloat(lat) : null;
    const contactLng = lng != null && !isNaN(lng) ? parseFloat(lng) : null;

    const info = await db.run(
      "INSERT INTO contacts (name, phone, label_id, notes, lat, lng) VALUES (?, ?, ?, ?, ?, ?)",
      [trimmedName, trimmedPhone, contactLabelId, contactNotes, contactLat, contactLng]
    );
    res.status(201).json({
      id: info.lastInsertRowid,
      name: trimmedName,
      phone: trimmedPhone,
      label_id: contactLabelId,
      notes: contactNotes,
      lat: contactLat,
      lng: contactLng,
    });
  } catch (err) {
    console.error("contacts: error creating contact", err.message);
    res.status(500).json({ error: "Error al crear contacto" });
  }
});

// PUT /api/contacts/:id — update a contact
router.put("/:id", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await db.get("SELECT id FROM contacts WHERE id = ?", [id]);
    if (!existing) {
      return res.status(404).json({ error: "Contacto no encontrado" });
    }

    const { name, phone, label_id, notes } = req.body || {};
    const updates = [];
    const params = [];

    if (name !== undefined) {
      updates.push("name = ?");
      params.push(String(name).trim());
    }
    if (phone !== undefined) {
      updates.push("phone = ?");
      params.push(String(phone).trim());
    }
    if (label_id !== undefined) {
      updates.push("label_id = ?");
      params.push(label_id || null);
    }
    if (notes !== undefined) {
      updates.push("notes = ?");
      params.push(notes ? String(notes).trim() : null);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: "No hay campos para actualizar" });
    }

    params.push(id);
    await db.run(`UPDATE contacts SET ${updates.join(", ")} WHERE id = ?`, params);

    const updated = await db.get(
      `SELECT c.id, c.name, c.phone, c.label_id, c.notes, c.created_at,
              cl.name AS label_name, cl.color AS label_color
       FROM contacts c
       LEFT JOIN contact_labels cl ON cl.id = c.label_id
       WHERE c.id = ?`,
      [id]
    );
    res.json(updated);
  } catch (err) {
    console.error("contacts: error updating contact", err.message);
    res.status(500).json({ error: "Error al actualizar contacto" });
  }
});

// DELETE /api/contacts/:id — delete a contact
router.delete("/:id", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await db.get("SELECT id FROM contacts WHERE id = ?", [id]);
    if (!existing) {
      return res.status(404).json({ error: "Contacto no encontrado" });
    }
    await db.run("DELETE FROM contacts WHERE id = ?", [id]);
    res.json({ ok: true });
  } catch (err) {
    console.error("contacts: error deleting contact", err.message);
    res.status(500).json({ error: "Error al eliminar contacto" });
  }
});

export default router;
