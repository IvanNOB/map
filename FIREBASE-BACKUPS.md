# 🔥 Copias de seguridad de la base de datos en Firebase (costo $0)

## El problema que resuelve

Tu app vive en Render y su base de datos es PostgreSQL. El detalle que te borraba
la información está en las condiciones del plan gratuito de Render (textual de su
documentación):

> **30-day limit: Free Render Postgres databases expire 30 days after creation.**
> An expired Free database is inaccessible unless you upgrade it to a paid compute
> plan. After a Free database expires, you have a grace period of 14 days to
> upgrade it… **After the grace period, Render deletes the database (along with all
> of its data).**
> **Free Render Postgres databases don't support any form of backups.**
> Y en el servicio web: **"Local files lost on redeploy."**

Es decir: **la base gratuita de Render se autodestruye cada 30 días y no tiene
backups**. Ese es el origen de "cada rato se me borra la información".

## La solución (dos capas)

**1. Base de datos que no caduca** → un PostgreSQL gratuito sin fecha de expiración
(Neon). Solo cambias `DATABASE_URL` en Render.

**2. Copia de seguridad automática en Firebase** (este repo) → cada hora (y al
apagar el servicio) la app hace un volcado lógico completo de todas las tablas y
lo guarda troceado en **Cloud Firestore**. Si la base se pierde o la recreas, el
servidor **se restaura solo** al arrancar cuando la encuentra vacía.

```
Panel / repartidor / cliente
        │  HTTPS + Socket.IO
        ▼
  Servidor Node (Render free) ────── cada 60 min ──────▶  Cloud Firestore (gratis)
        │  ▲                                                   │
        │  └──────── al arrancar con la base vacía: restaura ◀──┘
        ▼
  PostgreSQL (Neon, plan gratis y sin caducidad)
```

## Costo: $0

| Servicio | Plan gratuito | ¿Caduca? |
|---|---|---|
| **Cloud Firestore (Spark)** | 1 GiB almacenado, **20.000 escrituras/día**, 50.000 lecturas/día, 10 GiB egress/mes | **No** |
| **Neon Postgres (Free)** | 0,5 GB, 100 CU-horas/mes. Su documentación dice literalmente: *"None of these limits delete your data"* | **No** |
| Render (servicio web free) | El servicio se duerme y su disco es efímero | — (irrelevante: la base está fuera) |

Consumo real de la copia: un volcado de ~2 MB son ~4 documentos. Con una copia por
hora son ~120 escrituras/día como máximo, y **cero** si no hubo cambios (el módulo
compara el SHA-256 y no escribe nada). Muy por debajo del límite gratuito.

> ⚠️ **Por qué NO se usa Cloud Storage ni Cloud Functions**: desde septiembre de
> 2024 los buckets de Cloud Storage for Firebase y el despliegue de
> Functions/App Hosting **exigen el plan Blaze (con tarjeta)**. Firestore sigue
> siendo gratuito, así que el respaldo va ahí.

---

## Paso 1 — Base de datos que no caduca (Neon)

1. Entra a <https://neon.com> (ex neon.tech) y crea una cuenta (con GitHub, sin tarjeta).
2. **Create project** → región: la más cercana (por ejemplo `AWS us-east-1`).
   Neon crea una base llamada `neondb`.
3. Copia la **connection string** (botón *Connect*). Se ve así:

```
postgresql://usuario:clave@ep-xxx-pooler.us-east-1.aws.neon.tech/neondb?sslmode=require
```

4. En **Render → tu servicio → Environment**, cambia `DATABASE_URL` por esa cadena y
   guarda (Render redespliega solo).

> El código ya maneja el SSL (`?sslmode=require` funciona igual en Neon). Si algún
> día quieres volver, solo revierte la variable.

## Paso 2 — Crear el proyecto de Firebase y Firestore

1. <https://console.firebase.google.com> → **Crear proyecto** (`agencia-domicilios`, sin Analytics).
2. Menú lateral → **Compilación → Firestore Database** → **Crear base de datos**.
3. Ubicación: `southamerica-east1` (São Paulo) o `us-central1`. **No se puede cambiar después.**
4. Modo: **producción**.

## Paso 3 — Bloquear el acceso público

Firestore Database → pestaña **Reglas** → pega el contenido de
[`firestore.rules`](./firestore.rules) → **Publicar**.

Los datos solo los toca el servidor con la Admin SDK (que ignora estas reglas); el
navegador nunca habla con Firestore.

## Paso 4 — Credenciales de la cuenta de servicio

1. ⚙️ **Configuración del proyecto** → pestaña **Cuentas de servicio**.
2. **Generar nueva clave privada** → se descarga un `.json`. ⚠️ Es un secreto: **no lo subas a Git**.

## Paso 5 — Configurar Render

En **Render → tu servicio → Environment → Add Environment Variable**:

| Key | Value |
|---|---|
| `FIREBASE_PROJECT_ID` | el `project_id` del JSON |
| `FIREBASE_CLIENT_EMAIL` | el `client_email` del JSON |
| `FIREBASE_PRIVATE_KEY` | el `private_key` del JSON, **con los `\n` literales** tal como vienen entre comillas |

Guarda y deja que Render redespliegue. `render.yaml` ya declara esas tres claves.

> Si pegar la clave te da problemas, usa el JSON completo (crudo o en base64) en una
> sola variable `FIREBASE_SERVICE_ACCOUNT_JSON`. En PowerShell:
> `[Convert]::ToBase64String([IO.File]::ReadAllBytes("serviceAccount.json"))`

## Paso 6 — Migrar tus datos actuales (antes de que caduque la base de Render)

Mientras la base de Render siga viva, desde tu PC con el repo:

```powershell
$env:DATABASE_URL="postgresql://...la-cadena-de-RENDER..."   # tu base actual
$env:FIREBASE_PROJECT_ID="..."; $env:FIREBASE_CLIENT_EMAIL="..."
$env:FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
npm run backup:firestore        # volcado + subida a Firestore
```

Luego cambia `DATABASE_URL` a Neon y arranca: como la base estará vacía, **se
restaura sola** desde Firestore (o fuerza el proceso con `npm run restore:firestore`
usando la cadena de Neon).

## Verificar que todo quedó bien

| Comprobación | Cómo |
|---|---|
| Copias activas | `GET https://TU-APP.onrender.com/api/health` → `"backup": {"enabled": true, …}` |
| Estado y última copia | `npm run backup:status` (o `GET /api/backup/status` con token de admin) |
| Copia ahora mismo | `POST /api/backup/run` (admin) ó `npm run backup:firestore` |
| Ida y vuelta real contra tu Firestore | `npm run verify:firestore` |
| Prueba completa sin credenciales | `npm run test:backup-local` (simula deploy + reinicio) |
| Metadatos sin restaurar | `GET /api/backup/inspect` (admin) |

Prueba de oro: crea un pedido, fuerza la copia (`POST /api/backup/run`), apunta
`DATABASE_URL` a una base nueva vacía y reinicia. Debes ver en los logs
`Base restaurada desde Firestore` y tus datos de vuelta.

---

## Cómo funciona por dentro

| Pieza | Detalle |
|---|---|
| **Volcado lógico** | Descubre las tablas reales (`information_schema` en Postgres, `sqlite_master` en SQLite) y guarda columnas + filas como arrays (JSON compacto). Funciona igual en Postgres y en SQLite local. |
| **Troceado** | Firestore limita 1 MiB por documento → el JSON se pasa a base64 y se parte en trozos de 600.000 caracteres. |
| **Dos generaciones rotativas** | Cada copia se escribe en la generación *inactiva* (`a`/`b`) y solo al terminar se publica como activa. Si algo falla a medias, la copia buena sigue intacta y es la que se restaura. |
| **Sin copias inútiles** | Si el SHA-256 del volcado es el mismo que la copia activa, no se escribe **nada** en Firestore (ahorro de cuota). |
| **Red de seguridad** | Nunca reemplaza una copia con filas por una base vacía. |
| **Restauración** | `POST /api/backup/restore` (o el CLI) inserta los datos ignorando duplicados y **no borra nada** salvo que pidas `wipe`. En Postgres reajusta las secuencias `SERIAL`. |
| **Al arrancar** | Si la base está vacía, restaura automáticamente (`FIRESTORE_RESTORE=if-empty`). |
| **Al apagar** | Render envía `SIGTERM` al dormir el servicio o antes de un deploy: la app hace una copia final antes de morir (`db/database.js` → hooks de apagado). |
| **Automático** | Copia cada 60 minutos mientras el servicio está despierto. |

## Variables de entorno

| Variable | Default | Para qué |
|---|---|---|
| `FIREBASE_PROJECT_ID` / `FIREBASE_CLIENT_EMAIL` / `FIREBASE_PRIVATE_KEY` | — | Credenciales de la cuenta de servicio |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | — | Alternativa: JSON completo (crudo o base64) |
| `GOOGLE_APPLICATION_CREDENTIALS` | — | Alternativa: ruta a un JSON |
| `FIRESTORE_BACKUP_ENABLED` | activo si hay credenciales | `0/false/no/off` desactiva las copias |
| `FIRESTORE_BACKUP_INTERVAL_MINUTES` | `60` | Minutos entre copias (mínimo 5) |
| `FIRESTORE_BACKUP_COLLECTION` | `db_backups` | Colección destino |
| `FIRESTORE_BACKUP_MAX_MB` | `150` | Si el volcado supera este tamaño no se sube (y se avisa) |
| `FIRESTORE_BACKUP_SKIP_TABLES` | vacío | Tablas a omitir (ej: `location_history` si crece mucho) |
| `FIRESTORE_RESTORE` | `if-empty` | `if-empty` · `force` · `off` |

## Problemas comunes

| Síntoma | Causa / solución |
|---|---|
| `backup.enabled: false` en `/api/health` | Faltan las credenciales o `FIRESTORE_BACKUP_ENABLED=0`. Log: `Sin credenciales de Firebase…` |
| `DECODER routines::unsupported` | La `private_key` perdió los `\n`. Repégala con los `\n` literales, o usa `FIREBASE_SERVICE_ACCOUNT_JSON`. |
| `PERMISSION_DENIED` | La clave es de otro proyecto, o Firestore no está creado. |
| `NOT_FOUND` | No creaste la base de datos en Firestore (paso 2). |
| `RESOURCE_EXHAUSTED` | Se agotó la cuota diaria gratuita: sube `FIRESTORE_BACKUP_INTERVAL_MINUTES` o añade `FIRESTORE_BACKUP_SKIP_TABLES=location_history`. |
| `Copia cancelada: volcado demasiado grande` | Supera `FIRESTORE_BACKUP_MAX_MB`. Omite tablas grandes o sube el límite (1 GiB gratuito). |
| `El hash de la copia no coincide, probando la otra generación` | Una subida quedó a medias; el sistema usa la otra generación automáticamente. |
| La app arranca con datos viejos | La base ya tenía datos, así que no se restauró (es lo normal). Usa `npm run restore:firestore` o `POST /api/backup/restore`. |

## Archivos que toca esta función

| Archivo | Cambio |
|---|---|
| `db/backup-firestore.js` | **Nuevo.** Volcado, troceado, subida/descarga con dos generaciones, restauración y estado |
| `db/database.js` | Apagado ordenado: `onShutdown()` + `shutdown()` (los hooks corren antes de cerrar la base) |
| `db/seed.js` | `seed()` exportable y con `close` opcional; ya no se auto-ejecuta al importarse (+ `seedIfEmpty()`) |
| `server.js` | Arranca las copias (`startBackup()`), siembra si la base está vacía, monta `/api/backup` y publica el estado en `/api/health` |
| `src/backup.js` | **Nuevo.** Endpoints de admin: `status`, `run`, `restore`, `inspect` |
| `scripts/firestore-backup.mjs` | **Nuevo.** CLI `status` / `backup` / `restore` / `dump` |
| `scripts/verify-backup.mjs` | **Nuevo.** Prueba de ida y vuelta contra tu Firestore real |
| `scripts/test-backup-local.mjs` + `tests/firestore-stub/` | **Nuevos.** Prueba completa sin credenciales (simula deploy + reinicio) |
| `render.yaml` | Se quitó `npm run seed` del build y se declararon las variables `FIREBASE_*` |
| `.env.example` / `firestore.rules` / `package.json` | Documentación, reglas y dependencia `firebase-admin` (+ `engines: node >=22`) |

## Cómo desactivarlo

- Temporal: `FIRESTORE_BACKUP_ENABLED=0` (o borra las credenciales). Todo sigue
  funcionando igual, solo sin copias.
- Y si además quieres volver atrás con la base: apunta `DATABASE_URL` otra vez a
  Render Postgres (recordando que esa caduca a los 30 días).
