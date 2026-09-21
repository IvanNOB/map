#!/usr/bin/env node
/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Comprueba la copia en Firestore de punta a punta (ida y vuelta) contra tu
 * proyecto real, SIN tocar la copia buena: usa una colección de prueba
 * (db_backups_selftest) que se borra al terminar.
 *
 * Uso:  npm run verify:firestore
 *
 * Comprueba: credenciales, volcado, troceado, subida, descarga y que el
 * contenido descargado sea idéntico byte a byte al subido.
 * ─────────────────────────────────────────────────────────────────────────────
 */

process.env.FIRESTORE_BACKUP_COLLECTION = process.env.FIRESTORE_BACKUP_COLLECTION || "db_backups_selftest";
process.env.FIRESTORE_RESTORE = "off"; // no queremos restaurar nada aquí

import db, { init } from "../db/database.js";
import {
  initBackup,
  runBackup,
  downloadDump,
  dumpDatabase,
  serializeDump,
  backupStatus,
} from "../db/backup-firestore.js";

const results = [];
const check = (name, ok, extra = "") => {
  results.push({ name, ok: Boolean(ok), extra });
  console.log(`${ok ? "PASS" : "FAIL"} - ${name}${extra ? "  ::  " + extra : ""}`);
};

async function cleanup() {
  try {
    const appModule = await import("firebase-admin/app");
    const firestoreModule = await import("firebase-admin/firestore");
    const getApps = appModule.getApps || appModule.default.getApps;
    const getFirestore = firestoreModule.getFirestore || firestoreModule.default.getFirestore;
    const apps = getApps();
    const store = getFirestore(apps.length ? apps[0] : undefined);
    const collection = process.env.FIRESTORE_BACKUP_COLLECTION;
    const snapshots = await store.collection(collection).get();
    if (snapshots.size) {
      const batch = store.batch();
      snapshots.docs.forEach((doc) => batch.delete(doc.ref));
      await batch.commit();
    }
    console.log(`\nColección de prueba "${collection}" limpiada (${snapshots.size} documentos).`);
  } catch (err) {
    console.warn("No se pudo limpiar la colección de prueba:", err.message);
  }
}

await init();

// Una fila marcadora (inofensiva e idempotente) para que el volcado no esté vacío.
await db.run(
  "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ["verify_marker", new Date().toISOString()]
);

const ready = await initBackup();
if (!ready) {
  console.error("\n❌ Firestore no está configurado o la conexión falló.");
  console.error("   Define FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL y FIREBASE_PRIVATE_KEY (ver FIREBASE-BACKUPS.md).");
  await db.end();
  process.exit(1);
}
check("Conexión con Firestore", backupStatus().enabled === true);

const dump = await dumpDatabase();
const text = serializeDump(dump);
check("Volcado generado", dump.totals.tables > 0, `${dump.totals.tables} tablas, ${dump.totals.rows} filas`);

const result = await runBackup({ reason: "verify" });
check("Copia subida a Firestore", result && result.published === true, `${Math.round((result?.bytes || 0) / 1024)} KiB`);

const downloaded = await downloadDump();
check("Copia descargada", Boolean(downloaded));
check("El contenido coincide byte a byte", Boolean(downloaded) && downloaded.text === text);
check(
  "Troceado correcto (Firestore limita 1 MiB por documento)",
  Boolean(downloaded) && downloaded.info.count === Math.ceil(Buffer.from(text, "utf8").toString("base64").length / 600000),
  `trozo(s): ${downloaded?.info?.count}`
);
check(
  "El volcado descargado conserva todas las filas",
  Boolean(downloaded) && downloaded.info.rows === dump.totals.rows,
  `filas: ${downloaded?.info?.rows}`
);

await cleanup();
await db.end();

const failed = results.filter((r) => !r.ok);
console.log("\n================ RESUMEN ================");
console.log(`${results.length - failed.length}/${results.length} comprobaciones correctas`);
process.exit(failed.length ? 1 : 0);
