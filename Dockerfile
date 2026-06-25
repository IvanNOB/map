# Imagen para desplegar en Render, Railway, Fly.io, o cualquier plataforma con Docker
FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV PORT=3000
ENV NODE_ENV=production

EXPOSE 3000

# Sembrar (idempotente) y arrancar EN TIEMPO DE EJECUCION, cuando DATABASE_URL
# ya esta disponible y la base de datos es alcanzable. Si el seed falla, el
# servidor arranca de todos modos para no tumbar el servicio.
CMD ["sh", "-c", "node db/seed.js || true; node server.js"]
