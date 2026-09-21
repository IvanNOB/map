/**
 * Copias de seguridad de la base de datos en Firestore (solo administradores).
 *
 * - GET  /api/backup/status   estado de las copias
 * - POST /api/backup/run      fuerza una copia ahora
 * - POST /api/backup/restore  restaura la copia (requiere {"confirm":"RESTORE"})
 * - GET  /api/backup/inspect  metadatos de la copia sin restaurar
 */
import { Router } from "express";
import { requireAuth, requireRole } from "./auth.js";
import { backupStatus, runBackup, restoreFromCloud, downloadDump } from "../db/backup-firestore.js";

const router = Router();

router.get("/status", requireAuth, requireRole("admin"), (req, res) => {
  res.json(backupStatus());
});

router.post("/run", requireAuth, requireRole("admin"), async (req, res) => {
  const status = backupStatus();
  if (!status.enabled) {
    return res.status(409).json({
      error: "Las copias en Firestore están desactivadas (faltan las credenciales de Firebase)",
      status,
    });
  }
  const result = await runBackup({ reason: "manual" });
  res.json({ ok: Boolean(result && result.published), result, status: backupStatus() });
});

router.post("/restore", requireAuth, requireRole("admin"), async (req, res) => {
  const { confirm, wipe } = req.body || {};
  if (confirm !== "RESTORE") {
    return res.status(400).json({ error: 'Envía {"confirm":"RESTORE"} para confirmar la restauración' });
  }
  const summary = await restoreFromCloud({ wipe: wipe === true, reason: "http" });
  if (!summary) {
    return res.status(502).json({ error: "No se pudo restaurar: no hay una copia válida en Firestore" });
  }
  res.json({ ok: true, summary });
});

router.get("/inspect", requireAuth, requireRole("admin"), async (req, res) => {
  const downloaded = await downloadDump();
  if (!downloaded) return res.status(404).json({ error: "No hay copia disponible en Firestore" });
  res.json({
    generation: downloaded.generation,
    info: downloaded.info,
    bytes: Buffer.byteLength(downloaded.text, "utf8"),
    status: backupStatus(),
  });
});

export default router;
