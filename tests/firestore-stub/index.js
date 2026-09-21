/**
 * Stub de `firebase-admin` (app + firestore) para probar la copia durable sin
 * credenciales reales. Guarda los documentos en un archivo JSON (variable
 * STUB_FS_FILE) para poder simular un reinicio completo del servidor.
 *
 * NO se usa en producción: lo instala y desinstala
 * scripts/test-persistence-local.mjs.
 */
const fs = require("fs");
const nodePath = require("path");
const os = require("os");

// ─── firebase-admin/app ──────────────────────────────────────────────────────
const apps = [];

function initializeApp(options = {}) {
  const app = { options, name: options.name || "[DEFAULT]" };
  apps.push(app);
  return app;
}

function getApps() {
  return apps.slice();
}

function cert(serviceAccount) {
  return { __cert: serviceAccount };
}

function applicationDefault() {
  return { __adc: true };
}

// ─── firebase-admin/firestore (en memoria, persistido a JSON) ────────────────
const FILE = process.env.STUB_FS_FILE || nodePath.join(os.tmpdir(), "firebase-stub-firestore.json");

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch (_) {
    return {};
  }
}

let data = load();
let writeCount = 0;

function save() {
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
}

function snapshotOf(value) {
  return {
    exists: value !== undefined && value !== null,
    data: () => value,
    get: (key) => (value || {})[key],
  };
}

function makeRef(collection, id) {
  return {
    collection,
    id,
    async get() {
      return snapshotOf(data[collection] ? data[collection][id] : undefined);
    },
    async set(obj) {
      if (!data[collection]) data[collection] = {};
      data[collection][id] = JSON.parse(JSON.stringify(obj));
      writeCount++;
      save();
    },
    async delete() {
      if (data[collection]) {
        delete data[collection][id];
        writeCount++;
        save();
      }
    },
  };
}

function getFirestore() {
  return {
    settings() {},
    collection(name) {
      return {
        doc(id) {
          return makeRef(name, id);
        },
        async get() {
          const ids = Object.keys(data[name] || {});
          return { size: ids.length, docs: ids.map((id) => ({ ref: makeRef(name, id) })) };
        },
      };
    },
    batch() {
      const ops = [];
      return {
        set(ref, obj) {
          ops.push(() => {
            if (!data[ref.collection]) data[ref.collection] = {};
            data[ref.collection][ref.id] = JSON.parse(JSON.stringify(obj));
            writeCount++;
          });
        },
        delete(ref) {
          ops.push(() => {
            if (data[ref.collection]) {
              delete data[ref.collection][ref.id];
              writeCount++;
            }
          });
        },
        async commit() {
          ops.forEach((op) => op());
          save();
        },
      };
    },
    async getAll(...refs) {
      return refs.map((ref) => snapshotOf(data[ref.collection] ? data[ref.collection][ref.id] : undefined));
    },
    __writeCount: () => writeCount,
  };
}

module.exports = {
  initializeApp,
  getApps,
  cert,
  applicationDefault,
  getFirestore,
};
