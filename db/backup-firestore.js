/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Copias de seguridad de la base de datos en Cloud Firestore (plan GRATIS)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ¿Por qué? En Render, las bases PostgreSQL gratuitas **caducan a los 30 días**
 * y Render las borra (junto con todos sus datos) 14 días después. Además el
 * disco de los servicios web gratuitos es efímero y no hay backups. Este módulo
 * hace un volcado lógico (todas las tablas + filas) de la base actual, lo trocea
 * (Firestore limita 1 MiB por documento) y lo guarda en Firestore, que sí es
 * gratuito y no caduca.
 *
 * - PostgreSQL (DATABASE_URL) o SQLite local: la misma lógica sirve para ambos.
 * - Dos generaciones rotativas: la copia buena nunca se borra antes de que la
 *   nueva esté completa (y sirve de respaldo si la nueva falla).
 * - `npm run backup:firestore` fuerza una copia; `npm run restore:firestore`
 *   restaura. También se puede forzar por HTTP siendo admin (`POST /api/backup/run`).
 * - Si no hay credenciales de Firebase, todo queda desactivado y la app funciona
 *   exactamente igual que antes.
 *
 * Variables de entorno:
 *   FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY
 *   FIREBASE_SERVICE_ACCOUNT_JSON   (alternativa: JSON crudo o base64)
 *   GOOGLE_APPLICATION_CREDENTIALS  (alternativa: ruta a un JSON)
 *   FIRESTORE_BACKUP_ENABLED=0      desactiva las copias
 *   FIRESTORE_BACKUP_COLLECTION     colección destino (default: db_backups)
 *   FIRESTORE_BACKUP_INTERVAL_MINUTES  minutos entre copias (default: 60, mín: 5)
 *   FIRESTORE_BACKUP_MAX_MB         tamaño máximo del volcado (default: 150)
 *   FIRESTORE_BACKUP_SKIP_TABLES    tablas a omitir, separadas por coma
 *   FIRESTORE_RESTORE               if-empty (default) | force | off
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { createHash } from "crypto";
import db, { isPostgres, onShutdown } from "./database.js";
import logger from "../src/config/logger.js";

const COLLECTION = process.env.FIRESTORE_BACKUP_COLLECTION || "db_backups";
const CHUNK_CHARS = 600_000; // base64 ASCII → ~586 KiB por documento (< 1 MiB)
const INTERVAL_MS = clamp(Number(process.env.FIRESTORE_BACKUP_INTERVAL_MINUTES || 60), 5, 1440) * 60_000;
const MAX_BYTES = clamp(Number(process.env.FIRESTORE_BACKUP_MAX_MB || 150), 1, 1000) * 1024 * 1024;
const SKIP_TABLES = new Set(
  (process.env.FIRESTORE_BACKUP_SKIP_TABLES || "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)
);
const RESTORE_MODE = (process.env.FIRESTORE_RESTORE || "if-empty").toLowerCase();
const BACKUP_VERSION = 1;

// Orden de inserción seguro con claves foráneas (users antes que drivers/orders…).
const PREFERRED_ORDER = [
  "users",
  "drivers",
  "restaurants",
  "contact_labels",
  "contacts",
  "zones",
  "branches",
  "places",
  "settings",
  "orders",
  "order_proofs",
  "location_history",
  "messages",
  "push_subscriptions",
  "activity_log",
];

let firestore = null;
let enabled = false;
let initTried = false;

let currentGeneration = null; // "a" | "b"
let currentSha = null;
let inFlight = null;
let pendingReason = null;
let intervalTimer = null;

const stats = {
  enabled: false,
  backend: isPostgres ? "postgresql" : "sqlite",
  collection: COLLECTION,
  interval_minutes: INTERVAL_MS / 60_000,
  last_backup_at: null,
  last_backup_reason: null,
  last_backup_bytes: 0,
  last_backup_rows: 0,
  last_check_at: null,
  last_restore_at: null,
  last_restore_rows: 0,
  last_error: null,
  backups: 0,
  skipped: 0,
};

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

// ─── Credenciales y conexión con Firestore ───────────────────────────────────

function readCredentials() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (raw && raw.trim()) {
    const text = raw.trim().startsWith("{")
      ? raw.trim()
      : Buffer.from(raw.trim(), "base64").toString("utf8");
    try {
      return { kind: "cert", value: JSON.parse(text) };
    } catch (err) {
      logger.error("FIREBASE_SERVICE_ACCOUNT_JSON no es un JSON válido", { error: err.message });
      return null;
    }
  }

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  let privateKey = process.env.FIREBASE_PRIVATE_KEY;
  if (projectId && clientEmail && privateKey) {
    // Los paneles de hosting no admiten saltos de línea reales: se guardan como "\n".
    privateKey = privateKey.replace(/\\n/g, "\n");
    return { kind: "cert", value: { projectId, clientEmail, privateKey } };
  }

  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    return { kind: "adc", value: process.env.GOOGLE_APPLICATION_CREDENTIALS };
  }
  return null;
}

/** Carga firebase-admin dinámicamente para que la app arranque aunque falte. */
async function loadFirestore() {
  const appModule = await import("firebase-admin/app");
  const firestoreModule = await import("firebase-admin/firestore");

  const initializeApp = appModule.initializeApp || appModule.default?.initializeApp;
  const getApps = appModule.getApps || appModule.default?.getApps;
  const cert = appModule.cert || appModule.default?.cert;
  const applicationDefault = appModule.applicationDefault || appModule.default?.applicationDefault;
  const getFirestore = firestoreModule.getFirestore || firestoreModule.default?.getFirestore;

  if (!initializeApp || !getFirestore) throw new Error("firebase-admin no expone initializeApp/getFirestore");

  const apps = typeof getApps === "function" ? getApps() : [];
  let app = apps[0];
  if (!app) {
    const credentials = readCredentials();
    if (credentials.kind === "cert" && typeof cert === "function") {
      app = initializeApp({ credential: cert(credentials.value) });
    } else if (credentials.kind === "adc" && typeof applicationDefault === "function") {
      app = initializeApp({ credential: applicationDefault() });
    } else {
      app = initializeApp();
    }
  }

  const store = getFirestore(app);
  try {
    store.settings({ ignoreUndefinedProperties: true });
  } catch (_) {
    /* settings() solo se puede llamar antes del primer uso */
  }
  return store;
}

/**
 * Prepara la conexión con Firestore. Nunca lanza: si falla, las copias quedan
 * desactivadas y el servidor sigue funcionando con la base local/Postgres.
 * @returns {Promise<boolean>}
 */
export async function initBackup() {
  if (initTried) return enabled;
  initTried = true;

  const flag = String(process.env.FIRESTORE_BACKUP_ENABLED ?? "").toLowerCase();
  if (["0", "false", "no", "off"].includes(flag)) {
    logger.info("Copias en Firestore desactivadas (FIRESTORE_BACKUP_ENABLED)");
    return false;
  }
  if (!readCredentials()) {
    logger.info("Sin credenciales de Firebase: las copias en Firestore están desactivadas");
    return false;
  }

  try {
    firestore = await loadFirestore();
    enabled = true;
    stats.enabled = true;
    logger.info("Copias en Firestore activadas", {
      collection: COLLECTION,
      everyMinutes: INTERVAL_MS / 60_000,
      backend: stats.backend,
    });
  } catch (err) {
    enabled = false;
    stats.last_error = err.message;
    logger.error("No se pudo inicializar Firestore", { error: err.message });
  }
  return enabled;
}

function metaRef() {
  return firestore.collection(COLLECTION).doc("meta");
}

function chunkRef(generation, index) {
  return firestore
    .collection(COLLECTION)
    .doc(`chunk_${generation}_${String(index).padStart(5, "0")}`);
}

// ─── Volcado lógico de la base de datos ──────────────────────────────────────

/** Descubre las tablas reales de la base (sirve para Postgres y SQLite). */
async function listTables() {
  const rows = isPostgres
    ? await db.all(
        "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'"
      )
    : await db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'");

  return rows
    .map((r) => r.name)
    .filter((name) => typeof name === "string" && /^[a-z_][a-z0-9_]*$/i.test(name))
    .filter((name) => !SKIP_TABLES.has(name));
}

/** Ordena las tablas para que la restauración respete las claves foráneas. */
function sortTables(names) {
  const preferred = PREFERRED_ORDER.filter((t) => names.includes(t));
  const rest = names.filter((t) => !PREFERRED_ORDER.includes(t)).sort();
  return [...preferred, ...rest];
}

/** Convierte un valor de la base a algo serializable en JSON. */
function normalizeValue(value) {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return { __bytes: value.toString("base64") };
  if (typeof value === "object") return JSON.stringify(value);
  if (typeof value === "bigint") return Number(value);
  return value;
}

/** Convierte un valor del volcado de vuelta a lo que espera el driver. */
function denormalizeValue(value) {
  if (value && typeof value === "object" && typeof value.__bytes === "string") {
    return Buffer.from(value.__bytes, "base64");
  }
  return value;
}

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/i;

/**
 * Lee todas las tablas y devuelve el volcado lógico completo.
 * Las filas van como arrays para que el JSON sea mucho más pequeño.
 */
export async function dumpDatabase() {
  const tables = sortTables(await listTables());
  const dumpTables = {};
  let totalRows = 0;

  for (const name of tables) {
    const rows = await db.all(`SELECT * FROM ${name}`);
    if (!rows.length) {
      dumpTables[name] = { columns: [], rows: [] };
      continue;
    }
    const columns = Object.keys(rows[0]);
    dumpTables[name] = {
      columns,
      rows: rows.map((row) => columns.map((column) => normalizeValue(row[column]))),
    };
    totalRows += rows.length;
  }

  return {
    version: BACKUP_VERSION,
    backend: stats.backend,
    exported_at: new Date().toISOString(),
    tables: dumpTables,
    totals: { tables: tables.length, rows: totalRows },
  };
}

export function serializeDump(dump) {
  return JSON.stringify(dump);
}

export function deserializeDump(text) {
  const dump = JSON.parse(text);
  if (!dump || typeof dump !== "object" || !dump.tables) {
    throw new Error("El volcado no tiene el formato esperado");
  }
  return dump;
}

// ─── Restauración ────────────────────────────────────────────────────────────

const ROWS_PER_INSERT = 100;

/** Vacía las tablas (solo para restauraciones forzadas). */
async function wipeTables(names) {
  for (const name of [...names].reverse()) {
    if (!IDENTIFIER.test(name)) continue;
    try {
      if (isPostgres) await db.exec(`TRUNCATE TABLE ${name} RESTART IDENTITY CASCADE`);
      else await db.exec(`DELETE FROM ${name}`);
    } catch (err) {
      logger.warn(`No se pudo vaciar ${name}`, { error: err.message });
    }
  }
  if (!isPostgres) {
    try {
      await db.exec("DELETE FROM sqlite_sequence");
    } catch (_) {
      /* la tabla sqlite_sequence no existe si no hay AUTOINCREMENT */
    }
  }
}

/** Tras restaurar con ids explícitos, deja las secuencias de Postgres al día. */
async function fixSequences(names) {
  for (const name of names) {
    if (!IDENTIFIER.test(name)) continue;
    try {
      const row = await db.get("SELECT pg_get_serial_sequence(?, 'id') AS seq", [name]);
      const seq = row && row.seq;
      if (!seq || !/^[a-z0-9_."]+$/i.test(seq)) continue;
      const max = await db.get(`SELECT MAX(id) AS max FROM ${name}`);
      const value = Number(max && max.max) || 0;
      await db.exec(`SELECT setval('${seq}', ${value > 0 ? value : 1})`);
    } catch (err) {
      logger.warn(`No se pudo ajustar la secuencia de ${name}`, { error: err.message });
    }
  }
}

/**
 * Inserta los datos de un volcado. No borra nada salvo que se pida `wipe`.
 * Los ids se insertan tal cual y los conflictos se ignoran, así que es seguro
 * ejecutarlo sobre una base que ya tenga datos.
 */
export async function restoreDump(dump, { wipe = false } = {}) {
  const names = sortTables(Object.keys(dump.tables || {}));
  if (wipe) await wipeTables(names);

  const summary = { tables: 0, inserted: 0, failed: [] };

  for (const name of names) {
    const table = dump.tables[name];
    if (!table || !Array.isArray(table.columns) || !table.columns.length || !table.rows.length) continue;
    if (!IDENTIFIER.test(name)) continue;

    const columns = table.columns.filter((c) => IDENTIFIER.test(c));
    if (!columns.length) continue;
    const positions = columns.map((c) => table.columns.indexOf(c));
    const prefix = isPostgres ? "INSERT INTO" : "INSERT OR IGNORE INTO";
    const suffix = isPostgres ? " ON CONFLICT DO NOTHING" : "";
    const single = `(${columns.map(() => "?").join(", ")})`;

    for (let start = 0; start < table.rows.length; start += ROWS_PER_INSERT) {
      const slice = table.rows.slice(start, start + ROWS_PER_INSERT);
      const values = [];
      for (const row of slice) {
        for (const position of positions) values.push(denormalizeValue(row[position]));
      }
      const sql = `${prefix} ${name} (${columns.join(", ")}) VALUES ${slice
        .map(() => single)
        .join(", ")}${suffix}`;

      try {
        const result = await db.run(sql, values);
        summary.inserted += Number(result && result.changes) || 0;
      } catch (err) {
        // Si el lote falla (una columna que ya no existe, un tipo raro…) se
        // reintenta fila por fila para rescatar todo lo posible.
        logger.warn(`Lote rechazado en ${name}, reintentando fila por fila`, { error: err.message });
        for (const row of slice) {
          try {
            const result = await db.run(
              `${prefix} ${name} (${columns.join(", ")}) VALUES ${single}${suffix}`,
              positions.map((position) => denormalizeValue(row[position]))
            );
            summary.inserted += Number(result && result.changes) || 0;
          } catch (rowErr) {
            summary.failed.push(`${name}: ${rowErr.message}`);
          }
        }
      }
    }
    summary.tables++;
  }

  if (isPostgres) await fixSequences(names);
  return summary;
}

// ─── Firestore: subir / bajar el volcado ─────────────────────────────────────

function chunkDump(text) {
  const base64 = Buffer.from(text, "utf8").toString("base64");
  const chunks = [];
  for (let i = 0; i < base64.length; i += CHUNK_CHARS) chunks.push(base64.slice(i, i + CHUNK_CHARS));
  return chunks.length ? chunks : [""];
}

async function readMeta() {
  const snapshot = await metaRef().get();
  return snapshot.exists ? snapshot.data() || {} : null;
}

/**
 * Publica una nueva copia. Siempre escribe en la generación que NO está activa,
 * así la copia buena permanece intacta hasta que la nueva está completa.
 * @returns {Promise<boolean>} true si se publicó una copia nueva
 */
async function uploadDump(text, { reason, rows, contentHash }) {
  const bytes = Buffer.byteLength(text, "utf8");
  const hash = sha256(text);
  const meta = await readMeta();
  const previous = meta && meta.generations ? meta.generations[meta.current] : null;

  if (bytes > MAX_BYTES) {
    stats.last_error = `El volcado pesa ${(bytes / 1024 / 1024).toFixed(1)} MB y el máximo es ${MAX_BYTES / 1024 / 1024} MB`;
    logger.error("Copia cancelada: volcado demasiado grande", { bytes, maxMb: MAX_BYTES / 1024 / 1024 });
    return false;
  }
  // Los datos son los mismos que la última copia (el sello de tiempo no cuenta):
  // no se escribe NADA en Firestore. Así cada arranque del servicio no gasta cuota.
  if (previous && contentHash && previous.content_hash === contentHash) {
    stats.skipped++;
    logger.info("Sin cambios en los datos desde la última copia: no se escribió nada en Firestore", { reason });
    return false;
  }
  if (previous && previous.sha256 === hash) {
    stats.skipped++;
    logger.info("La copia es idéntica a la anterior: no se escribió nada en Firestore", { reason });
    return false;
  }
  // Red de seguridad: nunca reemplazar una copia con datos por una base vacía.
  if (previous && previous.rows > 0 && !rows) {
    stats.skipped++;
    logger.warn("La base parece vacía y ya hay una copia con datos: se omite la subida", { reason });
    return false;
  }

  const generation = meta && meta.current === "a" ? "b" : "a";
  const chunks = chunkDump(text);
  const hashes = chunks.map((chunk) => sha256(Buffer.from(chunk, "utf8")));

  // Documentos por lotes (el límite de un batch de Firestore es 500 escrituras).
  for (let start = 0; start < chunks.length; start += 400) {
    const batch = firestore.batch();
    for (let i = start; i < Math.min(start + 400, chunks.length); i++) {
      batch.set(chunkRef(generation, i), {
        index: i,
        generation,
        data: chunks[i],
        updated_at: new Date().toISOString(),
      });
    }
    await batch.commit();
  }

  // Trozos sobrantes de una copia anterior más grande en esta misma generación.
  const oldCount = (meta && meta.generations && meta.generations[generation]?.chunks?.length) || 0;
  if (oldCount > chunks.length) {
    const batch = firestore.batch();
    for (let i = chunks.length; i < oldCount; i++) batch.delete(chunkRef(generation, i));
    await batch.commit();
  }

  await metaRef().set({
    current: generation,
    generations: {
      ...((meta && meta.generations) || {}),
      [generation]: {
        chunks: hashes,
        count: chunks.length,
        size: bytes,
        sha256: hash,
        content_hash: contentHash || null,
        rows: rows || 0,
        backend: stats.backend,
        chunk_chars: CHUNK_CHARS,
        created_at: new Date().toISOString(),
        reason,
      },
    },
    updated_at: new Date().toISOString(),
    app: "agencia-domicilios",
  });

  currentGeneration = generation;
  currentSha = hash;
  stats.backups++;
  stats.last_backup_at = new Date().toISOString();
  stats.last_backup_reason = reason;
  stats.last_backup_bytes = bytes;
  stats.last_backup_rows = rows || 0;
  stats.last_error = null;
  logger.info("Copia guardada en Firestore", {
    generation,
    chunks: chunks.length,
    kb: Math.round(bytes / 1024),
    rows: rows || 0,
    reason,
  });
  return true;
}

/** Descarga la copia activa; si está incompleta, prueba la otra generación. */
export async function downloadDump() {
  if (!enabled) return null;
  const meta = await readMeta();
  if (!meta || !meta.generations) {
    logger.warn("Todavía no hay copias en Firestore");
    return null;
  }

  const generations = [meta.current, meta.current === "a" ? "b" : "a"].filter(Boolean);
  for (const generation of generations) {
    const info = meta.generations[generation];
    if (!info || !Array.isArray(info.chunks) || !info.chunks.length) continue;
    try {
      const snapshots = await firestore.getAll(...info.chunks.map((_, i) => chunkRef(generation, i)));
      const pieces = [];
      let complete = true;
      for (const snapshot of snapshots) {
        if (!snapshot.exists) {
          complete = false;
          break;
        }
        pieces.push(String(snapshot.get("data") || ""));
      }
      if (!complete) {
        logger.warn("Copia incompleta en Firestore, probando la otra generación", { generation });
        continue;
      }
      const text = Buffer.from(pieces.join(""), "base64").toString("utf8");
      if (info.sha256 && sha256(text) !== info.sha256) {
        logger.warn("El hash de la copia no coincide, probando la otra generación", { generation });
        continue;
      }
      return { text, generation, info };
    } catch (err) {
      logger.error("Error descargando la copia de Firestore", { generation, error: err.message });
    }
  }
  return null;
}

// ─── API pública ─────────────────────────────────────────────────────────────

/** true si todavía no hay usuarios (base vacía o recién creada). */
export async function isDatabaseEmpty() {
  try {
    const row = await db.get("SELECT COUNT(*) AS count FROM users");
    return Number(row && row.count) === 0;
  } catch (err) {
    logger.warn("No se pudo comprobar si la base está vacía", { error: err.message });
    return false;
  }
}

/**
 * Hace un volcado y lo sube a Firestore. Es seguro llamarlo varias veces: si
 * ya hay una copia en curso, se encola una segunda al terminar.
 * @param {{ reason?: string, dump?: object }} options `dump` permite subir un
 *        volcado ya calculado (así la verificación compara el mismo contenido).
 * @returns {Promise<object|null>} resumen de la copia (null si está desactivado o falló)
 */
export async function runBackup({ reason = "manual", dump = null } = {}) {
  if (!enabled) return null;
  if (inFlight) {
    pendingReason = reason;
    return inFlight;
  }

  inFlight = (async () => {
    const startedAt = Date.now();
    try {
      const snapshot = dump || (await dumpDatabase());
      const text = serializeDump(snapshot);
      // Hash del contenido real (ignorando el sello de tiempo) para saber si algo cambió.
      const contentHash = sha256(JSON.stringify({ ...snapshot, exported_at: null }));
      stats.last_check_at = new Date().toISOString();
      const published = await uploadDump(text, { reason, rows: snapshot.totals.rows, contentHash });
      return {
        published,
        bytes: Buffer.byteLength(text, "utf8"),
        rows: snapshot.totals.rows,
        tables: snapshot.totals.tables,
        sha256: sha256(text),
        ms: Date.now() - startedAt,
      };
    } catch (err) {
      stats.last_error = err.message;
      logger.error("Error creando la copia de seguridad", { error: err.message, reason });
      return null;
    } finally {
      inFlight = null;
      if (pendingReason) {
        const next = pendingReason;
        pendingReason = null;
        const timer = setTimeout(() => runBackup({ reason: next }).catch(() => {}), 2000);
        if (timer.unref) timer.unref();
      }
    }
  })();

  return inFlight;
}

/**
 * Copia final antes de apagar el servidor. Render envía SIGTERM al dormir el
 * servicio o antes de un deploy, así que este es el momento clave para no perder
 * los últimos cambios.
 */
export async function flushBackup({ timeoutMs = 20000 } = {}) {
  if (!enabled) return false;
  try {
    await Promise.race([
      inFlight || runBackup({ reason: "shutdown" }),
      new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
    return true;
  } catch (err) {
    logger.error("No se pudo completar la copia final", { error: err.message });
    return false;
  }
}

/** Descarga la copia de Firestore y la inserta en la base actual. */
export async function restoreFromCloud({ wipe = false, reason = "manual" } = {}) {
  const downloaded = await downloadDump();
  if (!downloaded) return null;

  let dump;
  try {
    dump = deserializeDump(downloaded.text);
  } catch (err) {
    stats.last_error = err.message;
    logger.error("La copia de Firestore no se pudo interpretar", { error: err.message });
    return null;
  }

  const summary = await restoreDump(dump, { wipe });
  stats.last_restore_at = new Date().toISOString();
  stats.last_restore_rows = summary.inserted;
  logger.info("Base restaurada desde Firestore", {
    generation: downloaded.generation,
    exported_at: dump.exported_at,
    tables: summary.tables,
    inserted: summary.inserted,
    failed: summary.failed.length,
    reason,
  });
  return {
    ...summary,
    generation: downloaded.generation,
    exported_at: dump.exported_at,
    rows_in_dump: dump.totals ? dump.totals.rows : null,
  };
}

/**
 * Arranca todo: conexión con Firestore, restauración si hace falta y copias
 * periódicas (+ copia final en SIGTERM). Nunca lanza.
 * @returns {Promise<boolean>} true si las copias quedaron activas
 */
export async function startBackup() {
  const ready = await initBackup();
  if (!ready) return false;

  if (RESTORE_MODE !== "off") {
    try {
      if (RESTORE_MODE === "force") {
        await restoreFromCloud({ reason: "boot-force" });
      } else if (await isDatabaseEmpty()) {
        await restoreFromCloud({ reason: "boot-empty-db" });
      } else {
        logger.info("La base ya tiene datos: no se restaura al arrancar");
      }
    } catch (err) {
      logger.error("Error restaurando la base al arrancar", { error: err.message });
    }
  }

  if (intervalTimer) clearInterval(intervalTimer);
  intervalTimer = setInterval(() => {
    runBackup({ reason: "interval" }).catch(() => {});
  }, INTERVAL_MS);
  if (intervalTimer.unref) intervalTimer.unref();

  // Copia final al apagar (SIGTERM/SIGINT) antes de que el host corte el proceso.
  onShutdown(async () => {
    await flushBackup();
  });

  // Copia de arranque: SIEMPRE se intenta poco después de levantar el servicio.
  // Si los datos no cambiaron respecto a la última copia, no se escribe nada en
  // Firestore (se compara el hash del contenido), así que cada despertar/dormida
  // de Render no gasta cuota. Si la base es nueva o cambió, sí copia.
  const startupTimer = setTimeout(() => runBackup({ reason: "startup" }).catch(() => {}), 30000);
  if (startupTimer.unref) startupTimer.unref();

  return true;
}

/** Estado de las copias (se expone en /api/health y /api/backup/status). */
export function backupStatus() {
  return {
    ...stats,
    current_generation: currentGeneration,
    last_snapshot: currentSha ? currentSha.slice(0, 12) : null,
    running: Boolean(inFlight),
  };
}
