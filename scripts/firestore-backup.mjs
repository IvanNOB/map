#!/usr/bin/env node
/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Utilidades de copia y restauración en Firestore desde la terminal.
 *
 *   npm run backup:status      estado + metadatos de la última copia
 *   npm run backup:firestore   volcado + subida a Firestore (migración incluida)
 *   npm run restore:firestore  descarga la copia e inserta los datos en la base
 *                              actual (añade --wipe para vaciar antes)
 *   node scripts/firestore-backup.mjs dump [archivo.json]
 *                              volcado local en un JSON, sin subir nada
 *
 * Usa las mismas variables de entorno que la app: DATABASE_URL (Postgres o
 * SQLite) y FIREBASE_* (ver FIREBASE-BACKUPS.md).
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { writeFileSync } from "fs";
import db, { init } from "../db/database.js";
import {
  initBackup,
  runBackup,
  restoreFromCloud,
  downloadDump,
  dumpDatabase,
  serializeDump,
  backupStatus,
} from "../db/backup-firestore.js";

const command = (process.argv[2] || "status").toLowerCase();

async function main() {
  await init();

  if (command === "dump") {
    const dump = await dumpDatabase();
    const text = serializeDump(dump);
    const file = process.argv[3] || `backup-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    writeFileSync(file, text);
    console.log(`Volcado escrito en ${file}`);
    console.log(
      `  tablas: ${dump.totals.tables} · filas: ${dump.totals.rows} · tamaño: ${(Buffer.byteLength(text) / 1024).toFixed(1)} KiB`
    );
    await db.end();
    return;
  }

  const ready = await initBackup();
  if (!ready) {
    console.error(
      "Firestore no está configurado. Define FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL y FIREBASE_PRIVATE_KEY (ver FIREBASE-BACKUPS.md)."
    );
    await db.end();
    process.exitCode = 1;
    return;
  }

  if (command === "status") {
    console.log("Estado:", JSON.stringify(backupStatus(), null, 2));
    const downloaded = await downloadDump();
    console.log(
      downloaded
        ? `Copia disponible: ${JSON.stringify({ generation: downloaded.generation, ...downloaded.info }, null, 2)}`
        : "Todavía no hay copia en Firestore."
    );
  } else if (command === "backup") {
    const result = await runBackup({ reason: "cli" });
    console.log(
      result && result.published
        ? "✅ Copia publicada en Firestore."
        : "⚠️  No se publicó copia nueva (no había cambios, o hubo un error: revisa los mensajes de arriba)."
    );
    if (result) console.log(JSON.stringify(result, null, 2));
  } else if (command === "restore") {
    const wipe = process.argv.includes("--wipe");
    const summary = await restoreFromCloud({ wipe, reason: "cli" });
    console.log(summary ? "✅ Restauración completada:" : "❌ No hay una copia válida en Firestore.");
    if (summary) console.log(JSON.stringify(summary, null, 2));
  } else {
    console.error(`Comando desconocido: "${command}". Usa: status | backup | restore | dump`);
    await db.end();
    process.exitCode = 1;
    return;
  }

  await db.end();
}

main().catch(async (err) => {
  console.error("Error:", err.message);
  try {
    await db.end();
  } catch (_) {
    /* ya estaba cerrada */
  }
  process.exitCode = 1;
});
