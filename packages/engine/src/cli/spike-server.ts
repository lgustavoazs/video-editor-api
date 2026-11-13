/**
 * Servidor TEMPORÁRIO da Fase 0: mede tempo e consumo de render no container da Railway.
 * Será substituído pela API (Fastify) na Fase 2.
 *
 *   GET /health                      -> 200
 *   GET /spike?token=...             -> renderiza o vídeo de teste e devolve as medições (JSON)
 *   GET /spike/video?token=...       -> baixa o último vídeo renderizado
 *
 * Parâmetros opcionais de /spike: x264 (preset do x264), photos (1-6).
 * Sem a variável SPIKE_TOKEN definida, as rotas /spike ficam desativadas.
 */
import { timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { availableParallelism, totalmem } from "node:os";
import { join } from "node:path";
import { EngineError } from "../errors.js";
import { getPlatform } from "../platforms.js";
import { loadPreset } from "../preset.js";
import { renderVideo } from "../render.js";
import { makeTestAssets } from "./make-test-assets.js";
import { OUT_DIR, PRESETS_DIR } from "./paths.js";

const PORT = Number(process.env.PORT ?? 3000);
const TOKEN = process.env.SPIKE_TOKEN ?? "";
const OUTPUT = join(OUT_DIR, "spike.mp4");
const X264_PRESETS = new Set(["ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow"]);

let busy = false;

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

function authorized(url: URL): boolean {
  if (TOKEN.length === 0) return false;
  const given = Buffer.from(url.searchParams.get("token") ?? "");
  const expected = Buffer.from(TOKEN);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  try {
    if (req.method !== "GET") return json(res, 405, { error: "method_not_allowed" });
    if (url.pathname === "/health") return json(res, 200, { status: "ok" });

    if (url.pathname === "/spike" || url.pathname === "/spike/video") {
      if (TOKEN.length === 0) return json(res, 503, { error: "spike_disabled", message: "Defina SPIKE_TOKEN" });
      if (!authorized(url)) return json(res, 401, { error: "unauthorized" });
    }

    if (url.pathname === "/spike") {
      if (busy) return json(res, 429, { error: "busy", message: "Já existe um render em andamento" });
      const x264 = url.searchParams.get("x264") ?? "medium";
      if (!X264_PRESETS.has(x264)) return json(res, 400, { error: "invalid_x264_preset" });
      const photoCount = Math.min(6, Math.max(1, Number(url.searchParams.get("photos") ?? 6) || 6));

      busy = true;
      try {
        const assets = await makeTestAssets();
        const result = await renderVideo({
          photos: assets.photos.slice(0, photoCount),
          preset: await loadPreset(join(PRESETS_DIR, "limpo.json")),
          platform: getPlatform("instagram_reels"),
          output: OUTPUT,
          timing: { mode: "audio" },
          audio: { file: assets.tone, start: 5, duration: 15 },
          encode: { x264Preset: x264 },
        });
        return json(res, 200, {
          machine: { cpus: availableParallelism(), memoryMb: Math.round(totalmem() / 1024 / 1024) },
          x264Preset: x264,
          duration: result.duration,
          photoCount: result.photoCount,
          stats: result.stats,
          warnings: result.warnings,
        });
      } finally {
        busy = false;
      }
    }

    if (url.pathname === "/spike/video") {
      const info = await stat(OUTPUT).catch(() => null);
      if (!info) return json(res, 404, { error: "not_found", message: "Chame /spike primeiro" });
      res.writeHead(200, { "content-type": "video/mp4", "content-length": info.size });
      createReadStream(OUTPUT).pipe(res);
      return;
    }

    return json(res, 404, { error: "not_found" });
  } catch (err) {
    if (err instanceof EngineError) {
      return json(res, 422, { error: err.code, message: err.message, details: err.details });
    }
    console.error(err);
    return json(res, 500, { error: "internal_error" });
  }
});

server.listen(PORT, () => {
  console.log(`Spike da Fase 0 ouvindo na porta ${PORT} (rotas /spike ${TOKEN ? "ativas" : "DESATIVADAS: defina SPIKE_TOKEN"})`);
});
