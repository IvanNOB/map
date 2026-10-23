#!/bin/sh
set -e

# Run seed only if the database file doesn't exist yet (first run)
if [ ! -f "${DB_PATH:-/app/db/data/data.sqlite}" ]; then
  echo "[entrypoint] Primera ejecucion: creando base de datos y ejecutando seed..."
  node db/seed.js
  echo "[entrypoint] Seed completado."
else
  echo "[entrypoint] Base de datos existente encontrada. Saltando seed."
fi

# Execute the main command (default: node server.js)
exec "$@"
