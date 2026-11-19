# API (Fastify) + site (React, servido em /app) + motor de vídeo (FFmpeg).
# Debian 13 (trixie) traz o FFmpeg 7; o motor exige 6.1 ou superior para ter as 58 transições.
FROM node:22-trixie-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/engine/package.json packages/engine/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci

COPY packages packages
COPY apps apps
COPY presets presets
COPY audio audio
COPY assets/fonts assets/fonts
RUN npm run build && npm prune --omit=dev

# Dados (banco, fila e vídeos) ficam em /data. Na Railway, é o volume persistente
# (montado como root: por isso RAILWAY_RUN_UID=0 lá). Fora dela, roda sem privilégios.
RUN mkdir -p /data out && chown -R node:node /data out
USER node

ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=3000
EXPOSE 3000
CMD ["node", "--disable-warning=ExperimentalWarning", "apps/api/dist/server.js"]
