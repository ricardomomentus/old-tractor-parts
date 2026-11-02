# Old Tractor Parts — imagen para Coolify
# Alpine: imagen chica y trae `wget` (Coolify lo usa para el health check).
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=3333 \
    DATA_DIR=/app/data

WORKDIR /app

# Dependencias primero (aprovecha la caché de Docker entre builds)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Código de la app
COPY server.js ./
COPY src ./src
COPY public ./public

# Carpeta de datos: aquí se monta el volumen persistente (DB + fotos).
# Se crea con dueño `node` para que el volumen nuevo herede los permisos.
RUN mkdir -p /app/data/uploads && chown -R node:node /app/data

USER node

EXPOSE 3333

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/health" || exit 1

CMD ["node", "server.js"]
