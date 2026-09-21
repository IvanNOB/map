#!/usr/bin/env node
/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Prueba automática de las copias en Firestore SIN credenciales reales.
 *
 * Uso:  npm run test:backup-local
 *
 * Qué hace:
 *   1. Instala un Firestore falso (tests/firestore-stub) en lugar de
 *      firebase-admin, moviendo el paquete real a node_modules/.firebase-admin-real.
 *   2. Arranca el servidor en modo SQLite, crea un repartidor y cambia un ajuste.
 *   3. Fuerza una copia con POST /api/backup/run y comprueba los documentos.
 *   4. Mata el proceso y BORRA el archivo SQLite (simula el disco efímero de
 *      Render al desplegar o al dormirse).
 *   5. Arranca otra vez y comprueba que todo se restaura desde "Firestore".
 *   6. Restaura SIEMPRE el paquete real (bloque finally).
 *
 * La base y el Firestore de prueba viven en la carpeta temporal del sistema:
 * NUNCA toca `db/data.sqlite` ni datos reales.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { spawn, execSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, cpSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MODULES = join(ROOT, "node_modules");
const ADMIN = join(MODULES, "firebase-admin");
const ADMIN_REAL = join(MODULES, ".firebase-admin-real");
const STUB_SRC = join(ROOT, "tests", "firestore-stub");
const DB = join(tmpdir(), "map-backup-test.sqlite");
const STUB_DATA = join(tmpdir(), "map-backup-test-firestore.json");
const PORT = Number(process.env.TEST_PORT || 3122);
const BASE = `http://127.0.0.1:${PORT}`;

const results = [];
let logs = "";
let child = null;

function check(name, condition, extra = "") {
  results.push({ name, ok: Boolean(condition), extra });
  console.log(`${condition ? "PASS" : "FAIL"} - ${name}${extra ? "  ::  " + extra : ""}`);
}

function installStub() {
  if (!existsSync(join(ADMIN, "package.json"))) {
    console.error("No está instalado node_modules/firebase-admin. Ejecuta primero: npm install");
    process.exit(1);
  }
  if (existsSync(ADMIN_REAL)) rmSync(ADMIN_REAL, { recursive: true, force: true });
  renameSync(ADMIN, ADMIN_REAL);
  cpSync(STUB_SRC, ADMIN, { recursive: true });
  console.log("Stub de firebase-admin instalado temporalmente.\n");
}

function restoreAdmin() {
  try {
    if (existsSync(ADMIN)) rmSync(ADMIN, { recursive: true, force: true });
    if (existsSync(ADMIN_REAL)) renameSync(ADMIN_REAL, ADMIN);
  } catch (err) {
    console.error("\n⚠️  No se pudo restaurar node_modules/firebase-admin:", err.message);
    console.error(`   Hazlo a mano: renombra "${ADMIN_REAL}" como "${ADMIN}".`);
  }
}

function startServer() {
  child = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      NODE_ENV: "production",
      DB_PATH: DB,
      // Sin DATABASE_URL → modo SQLite, para poder borrar el archivo y probar la restauración.
      DATABASE_URL: "",
      JWT_SECRET: "secreto-de-prueba",
      FIREBASE_PROJECT_ID: "stub-project",
      FIREBASE_CLIENT_EMAIL: "stub@stub.iam.gserviceaccount.com",
      FIREBASE_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\\nstub\\n-----END PRIVATE KEY-----\\n",
      STUB_FS_FILE: STUB_DATA,
      FIRESTORE_BACKUP_INTERVAL_MINUTES: "5", // el mínimo permitido
      LOG_LEVEL: "info",
      LOG_FORMAT: "pretty",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => (logs += d.toString()));
  child.stderr.on("data", (d) => (logs += d.toString()));
  return child;
}

async function stopServer() {
  if (!child) return;
  try {
    execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: "ignore" });
  } catch (_) {
    /* ya estaba detenido */
  }
  child = null;
  await sleep(1500);
}

async function api(path, options = {}) {
  const res = await fetch(BASE + path, options);
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch (_) {
    body = text;
  }
  return { status: res.status, body };
}

async function waitForHealth(timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(BASE + "/api/health");
      if (res.ok) return await res.json();
    } catch (_) {
      /* todavía arrancando */
    }
    await sleep(800);
  }
  return null;
}

async function loginAdmin() {
  const res = await api("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "admin@agencia.com", password: "admin123" }),
  });
  return {
    res,
    headers: { Authorization: `Bearer ${res.body?.token}`, "Content-Type": "application/json" },
  };
}

function readStubData() {
  return existsSync(STUB_DATA) ? JSON.parse(readFileSync(STUB_DATA, "utf8")) : null;
}

installStub();

try {
  if (existsSync(DB)) rmSync(DB);
  if (existsSync(STUB_DATA)) rmSync(STUB_DATA);

  // ── Arranque 1: primer despliegue ─────────────────────────────────────────
  startServer();
  const health1 = await waitForHealth();
  check("El servidor arranca y /api/health responde", health1 && health1.status === "healthy", JSON.stringify(health1?.database));
  check("Modo SQLite (sin DATABASE_URL)", health1?.database?.type === "sqlite");
  check("Copias en Firestore activadas", health1?.backup?.enabled === true, JSON.stringify(health1?.backup));

  const l1 = await loginAdmin();
  check("Sembrado automático: login del admin", l1.res.status === 200 && Boolean(l1.res.body?.token), `HTTP ${l1.res.status}`);

  const driver = await api("/api/drivers", {
    method: "POST",
    headers: l1.headers,
    body: JSON.stringify({
      name: "PRUEBA COPIAS",
      email: "prueba.copias@test.com",
      password: "clave12345",
      phone: "3001234567",
      vehicle: "Moto",
      plate: "TST01",
    }),
  });
  check("Se crea un repartidor (tablas users + drivers)", driver.status === 201, `HTTP ${driver.status}`);

  const settings = await api("/api/settings", {
    method: "PUT",
    headers: l1.headers,
    body: JSON.stringify({ agency_name: "AGENCIA DE PRUEBA" }),
  });
  check("Se cambia un ajuste", settings.status === 200 && settings.body?.agency_name === "AGENCIA DE PRUEBA");

  // ── Copia manual (el intervalo real es de minutos: aquí se fuerza) ────────
  const run = await api("/api/backup/run", { method: "POST", headers: l1.headers });
  check("POST /api/backup/run publica la copia", run.status === 200 && run.body?.ok === true, JSON.stringify(run.body?.result));

  const stub = readStubData();
  const meta = stub?.db_backups?.meta;
  const active = meta?.generations?.[meta?.current];
  check("Firestore recibió el documento meta", Boolean(meta), JSON.stringify(active));
  check(
    "La copia tiene trozo(s) y hash SHA-256",
    Array.isArray(active?.chunks) && active.chunks.length > 0 && typeof active.sha256 === "string",
    `${active?.chunks?.length} trozo(s), generación ${meta?.current}`
  );
  check("El volcado contiene filas", (active?.rows || 0) > 0, `filas: ${active?.rows}`);
  check("Los trozos están guardados en Firestore", Object.keys(stub?.db_backups || {}).some((k) => k.startsWith("chunk_")), Object.keys(stub?.db_backups || {}).join(", "));

  await stopServer();

  // ── Simulación de disco efímero (deploy / dormida del servicio) ───────────
  if (existsSync(DB)) rmSync(DB);
  check("Disco local borrado (simula el reinicio de Render)", !existsSync(DB));

  // ── Arranque 2: tras el reinicio ──────────────────────────────────────────
  logs = "";
  startServer();
  const health2 = await waitForHealth();
  check("El servidor vuelve a arrancar", Boolean(health2));
  check(
    "Los logs confirman la restauración desde Firestore",
    logs.includes("Base restaurada desde Firestore"),
    logs.split(/\r?\n/).filter((l) => l.includes("Firestore") || l.includes("restaurada")).join(" | ")
  );
  check("El archivo SQLite se volvió a escribir en disco", existsSync(DB));

  const l2 = await loginAdmin();
  check("Login del admin tras el reinicio", l2.res.status === 200, `HTTP ${l2.res.status}`);

  const drivers = await api("/api/drivers", { headers: l2.headers });
  const names = Array.isArray(drivers.body) ? drivers.body.map((d) => d.name) : [];
  check(
    "El repartidor creado antes del reinicio sigue ahí",
    names.includes("PRUEBA COPIAS"),
    `HTTP ${drivers.status} → ${JSON.stringify(names)}`
  );

  const settings2 = await api("/api/settings", { headers: l2.headers });
  check(
    "El ajuste guardado antes del reinicio sigue ahí",
    settings2.body?.agency_name === "AGENCIA DE PRUEBA",
    `agency_name: ${settings2.body?.agency_name}`
  );

  await stopServer();
} catch (err) {
  check("La prueba se ejecutó sin excepciones", false, err.stack);
} finally {
  await stopServer();
  restoreAdmin();
  if (existsSync(DB)) rmSync(DB);
  if (existsSync(STUB_DATA)) rmSync(STUB_DATA);
}

const failed = results.filter((r) => !r.ok);
console.log("\n================ RESUMEN ================");
console.log(`${results.length - failed.length}/${results.length} comprobaciones correctas`);
if (failed.length) {
  console.log("Fallidas:");
  for (const f of failed) console.log(`  - ${f.name}${f.extra ? "  ::  " + f.extra : ""}`);
}
process.exit(failed.length ? 1 : 0);
