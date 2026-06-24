# Para desplegar en Railway, Fly.io, o cualquier plataforma con Docker
FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --production

COPY . .
RUN node db/seed.js

ENV PORT=3000
ENV NODE_ENV=production

EXPOSE 3000

CMD ["node", "server.js"]
