# Motor + servidor temporário de medição (spike).
# Debian 13 (trixie) traz o FFmpeg 7; o motor exige 6.1 ou superior para ter as 58 transições.
FROM node:22-trixie-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/engine/package.json packages/engine/
RUN npm ci

COPY packages packages
COPY presets presets
COPY assets/fonts assets/fonts
RUN npm run build && npm prune --omit=dev

# O processo roda sem privilégios e só escreve nestas pastas.
RUN mkdir -p out assets/test && chown -R node:node out assets
USER node

ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "packages/engine/dist/cli/spike-server.js"]
