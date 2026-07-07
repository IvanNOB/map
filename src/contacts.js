import { Router } from "express";
import db from "../db/database.js";
import { requireAuth, requireRole } from "./auth.js";

const router = Router();

// Initialize tables
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS contact_labels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '#d4af37',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      label_id INTEGER,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (label_id) REFERENCES contact_labels(id) ON DELETE SET NULL
    );
  `);
} catch (err) {
  console.error("contacts: error initializing tables", err.message);
}

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
      SELECT c.id, c.name, c.phone, c.label_id, c.notes, c.created_at,
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
    const { name, phone, label_id, notes } = req.body || {};
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

    const info = await db.run(
      "INSERT INTO contacts (name, phone, label_id, notes) VALUES (?, ?, ?, ?)",
      [trimmedName, trimmedPhone, contactLabelId, contactNotes]
    );
    res.status(201).json({
      id: info.lastInsertRowid,
      name: trimmedName,
      phone: trimmedPhone,
      label_id: contactLabelId,
      notes: contactNotes,
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
