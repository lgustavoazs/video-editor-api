# Imagem da Fase 0: motor + servidor temporário de medição (spike).
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/engine/package.json packages/engine/
RUN npm ci

COPY packages packages
COPY presets presets
RUN npm run build && npm prune --omit=dev

# O processo roda sem privilégios e só escreve nestas pastas.
RUN mkdir -p out assets/test && chown -R node:node out assets
USER node

ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "packages/engine/dist/cli/spike-server.js"]
