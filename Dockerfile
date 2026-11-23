# Imagen para desplegar en Render, Railway, Fly.io, o cualquier plataforma con Docker
FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV PORT=3000
ENV NODE_ENV=production

EXPOSE 3000

# server.js restaura la copia antes de inicializar una base nueva.
CMD ["node", "server.js"]
