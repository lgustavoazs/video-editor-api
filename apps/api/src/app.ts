import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, stat, statfs } from "node:fs/promises";
import { availableParallelism, cpus, freemem, totalmem } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import multipart from "@fastify/multipart";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import {
  availableFilters,
  defaultThreads,
  EngineError,
  getPlatform,
  listPlatforms,
  makeTestAssets,
  planRender,
  presetSchema,
  type RenderItem,
} from "@video-editor/engine";
import type { ApiConfig } from "./config.js";
import { Db, type JobRow, type KeyRow } from "./db.js";
import { ApiError, toHttpError } from "./errors.js";
import { cleanup, inputDir, jobDir, JobQueue, outputFile, type StoredRequest } from "./jobs.js";
import { createKey, findActiveKey, publicKey, RateLimiter, sameSecret } from "./keys.js";
import { parseOptions, referencedFiles, type VideoOptions } from "./options.js";
import { applyOverrides, PresetLibrary } from "./presets.js";
import { checkFile, discard, receiveUpload } from "./upload.js";

const run = promisify(execFile);
export const API_VERSION = "2A";

declare module "fastify" {
  interface FastifyRequest {
    apiKey?: KeyRow;
  }
}

export interface App {
  app: FastifyInstance;
  db: Db;
  queue: JobQueue;
  /** Encerra servidor, fila e banco. */
  close(): Promise<void>;
}

/** Esconde chaves que aparecem na URL (?key=) nos logs. */
function safeUrl(url: string): string {
  return url.replace(/([?&]key=)[^&]*/g, "$1***");
}

export async function buildApp(cfg: ApiConfig, opts: { logger?: boolean } = {}): Promise<App> {
  const app = Fastify({
    logger:
      opts.logger === false
        ? false
        : {
            redact: ["req.headers.authorization", "req.headers['x-api-key']", "req.headers['x-admin-key']"],
            serializers: {
              req: (req: { method: string; url: string; ip?: string }) => ({ method: req.method, url: safeUrl(req.url), ip: req.ip }),
            },
          },
    bodyLimit: 1024 * 1024,
    trustProxy: true,
  });
  const log = app.log;
  const db = new Db(cfg.dataDir);
  const queue = new JobQueue(db, cfg, log);
  const presets = new PresetLibrary(cfg.presetsDir);
  const limiter = new RateLimiter(cfg.rateLimitPerMinute);
  const createLimiter = new RateLimiter(cfg.createLimitPerMinute);

  await app.register(multipart, { throwFileSizeLimit: true });

  app.setErrorHandler((err, req, reply) => {
    const { status, body } = toHttpError(err);
    if (status >= 500) req.log.error({ err }, "erro interno");
    void reply.code(status).send(body);
  });
  app.setNotFoundHandler((req, reply) => {
    void reply.code(404).send({ error: { code: "not_found", message: `Rota não encontrada: ${req.method} ${safeUrl(req.url)}` } });
  });

  // ---------------- autenticação ----------------

  function bearer(req: FastifyRequest): string | undefined {
    const h = req.headers.authorization;
    if (h?.startsWith("Bearer ")) return h.slice(7).trim();
    const x = req.headers["x-api-key"];
    return typeof x === "string" ? x.trim() : undefined;
  }

  async function requireKey(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const key = bearer(req);
    if (!key) throw new ApiError(401, "unauthorized", "Envie a chave da API em Authorization: Bearer <chave>");
    const row = findActiveKey(db, key);
    if (!row) throw new ApiError(401, "unauthorized", "Chave da API inválida ou revogada");
    const wait = limiter.hit(row.id);
    if (wait) {
      void reply.header("retry-after", String(wait));
      throw new ApiError(429, "rate_limited", `Limite de requisições atingido. Tente de novo em ${wait} s.`);
    }
    req.apiKey = row;
    db.touchKey(row.id, Date.now());
  }

  async function requireAdmin(req: FastifyRequest): Promise<void> {
    if (!cfg.adminKey) throw new ApiError(404, "not_found", "Administração desativada (defina ADMIN_KEY)");
    const header = req.headers["x-admin-key"];
    let given = typeof header === "string" ? header : bearer(req);
    if (!given && cfg.allowAdminQueryKey && req.method === "GET") {
      const q = (req.query as Record<string, unknown> | undefined)?.key;
      if (typeof q === "string") given = q;
    }
    if (!given || !sameSecret(given, cfg.adminKey)) {
      throw new ApiError(401, "unauthorized", "Chave de administrador inválida");
    }
  }

  function baseUrl(req: FastifyRequest): string {
    return cfg.publicUrl ?? `${req.protocol}://${req.host}`;
  }

  // ---------------- representação de pedidos ----------------

  function jobView(job: JobRow, req: FastifyRequest, admin = false) {
    const base = baseUrl(req);
    const error = job.error_json ? (JSON.parse(job.error_json) as { code: string; message: string; internal?: unknown }) : null;
    const result = job.result_json ? (JSON.parse(job.result_json) as Record<string, unknown>) : null;
    const iso = (t: number | null) => (t ? new Date(t).toISOString() : null);
    const view: Record<string, unknown> = {
      id: job.id,
      status: job.status,
      progress: Math.round(job.progress * 1000) / 10,
      queuePosition: job.status === "queued" ? queue.position(job.id) : null,
      createdAt: iso(job.created_at),
      startedAt: iso(job.started_at),
      finishedAt: iso(job.finished_at),
      expiresAt: iso(job.expires_at),
      warnings: JSON.parse(job.warnings_json) as string[],
      error: error ? { code: error.code, message: error.message, ...(admin && error.internal ? { internal: error.internal } : {}) } : null,
    };
    if (result) {
      const { stats, ...rest } = result;
      view.result = admin ? result : rest;
      view.sizeBytes = job.output_bytes;
    }
    if (job.status === "done") {
      view.downloadUrl = admin ? `${base}/v1/admin/jobs/${job.id}/download` : `${base}/v1/videos/${job.id}/download`;
    }
    if (admin) view.keyId = job.key_id;
    return view;
  }

  function ownJob(req: FastifyRequest, id: string): JobRow {
    const job = /^[0-9a-f-]{36}$/.test(id) ? db.job(id) : undefined;
    if (!job || job.key_id !== req.apiKey?.id) throw new ApiError(404, "video_not_found", "Vídeo não encontrado");
    return job;
  }

  async function sendVideo(job: JobRow, req: FastifyRequest, reply: FastifyReply) {
    if (job.status === "expired" || job.status === "deleted") {
      throw new ApiError(410, "video_expired", "O vídeo expirou ou foi apagado");
    }
    if (job.status !== "done") throw new ApiError(409, "video_not_ready", `O vídeo ainda não está pronto (status: ${job.status})`);
    const file = outputFile(cfg, job.id);
    const size = (await stat(file).catch(() => undefined))?.size;
    if (size === undefined) throw new ApiError(410, "video_expired", "O vídeo não está mais disponível");
    void reply
      .header("content-type", "video/mp4")
      .header("accept-ranges", "bytes")
      .header("content-disposition", `attachment; filename="video-${job.id.slice(0, 8)}.mp4"`)
      .header("cache-control", "private, max-age=3600");
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
    if (range && (range[1] || range[2])) {
      let start = range[1] ? Number(range[1]) : size - Number(range[2]);
      let end = range[1] && range[2] ? Number(range[2]) : size - 1;
      start = Math.max(0, start);
      end = Math.min(size - 1, end);
      if (start > end) {
        return reply.code(416).header("content-range", `bytes */${size}`).send();
      }
      return reply
        .code(206)
        .header("content-range", `bytes ${start}-${end}/${size}`)
        .header("content-length", String(end - start + 1))
        .send(createReadStream(file, { start, end }));
    }
    return reply.header("content-length", String(size)).send(createReadStream(file));
  }

  async function diskFree(): Promise<number> {
    const s = await statfs(cfg.dataDir);
    return s.bavail * s.bsize;
  }

  // ---------------- criação de pedidos ----------------

  /** Valida, planeja e coloca na fila. Usado pelo upload e pelo autoteste. */
  async function submit(id: string, keyId: string, options: VideoOptions, paths: Map<string, string>, extraWarnings: string[]) {
    const warnings = [...extraWarnings];
    if (options.audio?.libraryId !== undefined || options.audio?.mood !== undefined) {
      throw new ApiError(501, "not_available", "A biblioteca de áudio (libraryId/mood) chega na Fase 2B. Por enquanto, envie o arquivo de áudio.");
    }
    if (options.callbackUrl) warnings.push("callbackUrl foi guardado, mas o aviso por webhook só passa a ser enviado na Fase 2B.");
    const preset = applyOverrides(await presets.get(options.preset ?? cfg.defaultPreset), options.overrides);
    const platformId = options.platform ?? "instagram_reels";
    const platform = getPlatform(platformId);
    const path = (field: string) => paths.get(field)!;
    const items: RenderItem[] = options.items.map((it) => ({ ...it, type: it.type!, file: path(it.file) }));
    const audio = options.audio?.file ? { ...options.audio, file: path(options.audio.file) } : undefined;
    if (audio) {
      delete (audio as { libraryId?: unknown }).libraryId;
      delete (audio as { mood?: unknown }).mood;
    }
    const stored: StoredRequest = {
      items,
      preset,
      platform: platform.id,
      timing: { mode: options.timing?.mode ?? (audio ? "audio" : "fixed"), total: options.timing?.total },
      audio,
      logos: options.logos?.map((l) => ({ role: l.role, file: path(l.file) })),
      title: options.title,
    };
    const plan = await planRender({ ...stored, platform, assets: cfg.assets });
    warnings.push(...plan.warnings);
    if (queue.isFull()) throw new ApiError(503, "queue_full", "A fila está cheia. Tente de novo em alguns minutos.");
    db.insertJob({
      id,
      key_id: keyId,
      created_at: Date.now(),
      request_json: JSON.stringify(stored),
      warnings_json: JSON.stringify([...new Set(warnings)]),
      callback_url: options.callbackUrl ?? null,
    });
    queue.enqueue(id);
    return { duration: plan.duration, itemCount: plan.itemCount, warnings: [...new Set(warnings)] };
  }

  app.post("/v1/videos", { preHandler: requireKey }, async (req, reply) => {
    const keyId = req.apiKey!.id;
    const wait = createLimiter.hit(`create:${keyId}`);
    if (wait) {
      void reply.header("retry-after", String(wait));
      throw new ApiError(429, "rate_limited", `Limite de vídeos por minuto atingido. Tente de novo em ${wait} s.`);
    }
    if (queue.isFull()) throw new ApiError(503, "queue_full", "A fila está cheia. Tente de novo em alguns minutos.");
    if ((await diskFree()) < cfg.minFreeBytes) {
      req.log.error("disco sem espaço livre suficiente");
      throw new ApiError(503, "insufficient_storage", "Servidor sem espaço temporário. Tente mais tarde.");
    }

    const id = randomUUID();
    const dir = inputDir(cfg, id);
    try {
      const upload = await receiveUpload(req, cfg, dir);
      const options = parseOptions(upload.options);
      const refs = referencedFiles(options);
      const warnings: string[] = [];
      for (const field of upload.files.keys()) {
        if (!refs.has(field)) warnings.push(`O arquivo "${field}" foi enviado mas não é usado em options e foi ignorado.`);
      }
      const paths = new Map<string, string>();
      for (const [field] of refs) {
        const file = upload.files.get(field);
        if (!file) throw new ApiError(400, "missing_file", `options cita o arquivo "${field}", mas ele não foi enviado`, { field });
        paths.set(field, file.path);
      }
      options.items.forEach((it, i) => {
        const file = upload.files.get(it.file)!;
        const detected = file.sniffed.kind === "video" ? "clip" : "photo";
        if (it.type && it.type !== detected && file.sniffed.kind !== "heic" && file.sniffed.kind !== "unknown") {
          throw new ApiError(415, "unsupported_format", `options.items[${i}]: declarado como ${it.type}, mas o arquivo "${it.file}" é ${file.sniffed.kind === "video" ? "um vídeo" : "uma imagem"}`);
        }
        it.type ??= detected;
        checkFile(cfg, file, it.type, `options.items[${i}] ("${it.file}")`);
      });
      if (options.audio?.file) checkFile(cfg, upload.files.get(options.audio.file)!, "audio", `options.audio ("${options.audio.file}")`);
      options.logos?.forEach((l, i) => checkFile(cfg, upload.files.get(l.file)!, "logo", `options.logos[${i}] ("${l.file}")`));

      const planned = await submit(id, keyId, options, paths, warnings);
      const base = baseUrl(req);
      return reply.code(202).send({
        id,
        status: "queued",
        queuePosition: queue.position(id) || null,
        estimatedDuration: planned.duration,
        itemCount: planned.itemCount,
        warnings: planned.warnings,
        statusUrl: `${base}/v1/videos/${id}`,
      });
    } catch (err) {
      await discard(jobDir(cfg, id));
      throw err;
    }
  });

  app.get<{ Params: { id: string } }>("/v1/videos/:id", { preHandler: requireKey }, async (req) => jobView(ownJob(req, req.params.id), req));

  app.get<{ Params: { id: string } }>("/v1/videos/:id/download", { preHandler: requireKey }, async (req, reply) =>
    sendVideo(ownJob(req, req.params.id), req, reply),
  );

  app.delete<{ Params: { id: string } }>("/v1/videos/:id", { preHandler: requireKey }, async (req, reply) => {
    const job = ownJob(req, req.params.id);
    if (job.status === "processing") throw new ApiError(409, "video_processing", "O vídeo está sendo renderizado; aguarde terminar para apagar");
    if (job.status === "queued") {
      queue.remove(job.id);
      db.update(job.id, { status: "canceled", finished_at: Date.now() });
    } else if (job.status === "done") {
      db.update(job.id, { status: "deleted" });
    }
    await discard(jobDir(cfg, job.id));
    return reply.code(204).send();
  });

  // ---------------- consulta ----------------

  app.get("/health", async () => ({ ok: true, version: API_VERSION }));

  app.get("/v1/presets", { preHandler: requireKey }, async () => ({ presets: await presets.list() }));
  app.get("/v1/presets/schema", { preHandler: requireKey }, async () => presetSchema);
  app.get<{ Params: { id: string } }>("/v1/presets/:id", { preHandler: requireKey }, async (req) => presets.get(req.params.id));
  app.get("/v1/platforms", { preHandler: requireKey }, async () => ({ platforms: listPlatforms() }));

  // ---------------- administração ----------------

  app.post<{ Body: { name?: unknown } }>("/v1/admin/keys", { preHandler: requireAdmin }, async (req, reply) => {
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    if (!name || name.length > 80) throw new ApiError(400, "invalid_name", 'Informe "name" (até 80 caracteres) para identificar a chave');
    const created = createKey(db, name);
    return reply.code(201).send({
      ...created,
      name,
      warning: "Guarde a chave agora: ela não é exibida de novo (o servidor guarda só o hash).",
    });
  });

  app.get("/v1/admin/keys", { preHandler: requireAdmin }, async () => ({ keys: db.listKeys().map(publicKey) }));

  app.delete<{ Params: { id: string } }>("/v1/admin/keys/:id", { preHandler: requireAdmin }, async (req, reply) => {
    if (!db.revokeKey(req.params.id, Date.now())) throw new ApiError(404, "key_not_found", "Chave não encontrada ou já revogada");
    return reply.code(204).send();
  });

  app.get("/v1/admin/info", { preHandler: requireAdmin }, async () => {
    const filters = await availableFilters().catch(() => new Set<string>());
    const ffmpegVersion = await run(process.env.FFMPEG_PATH ?? "ffmpeg", ["-hide_banner", "-version"], { timeout: 10_000 })
      .then((r) => r.stdout.split("\n")[0])
      .catch((e: Error) => `indisponível: ${e.message}`);
    const disk = await statfs(cfg.dataDir).catch(() => undefined);
    let writable = true;
    try {
      await mkdir(join(cfg.dataDir, "jobs"), { recursive: true });
      await readdir(join(cfg.dataDir, "jobs"));
    } catch {
      writable = false;
    }
    return {
      version: API_VERSION,
      commit: process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
      node: process.version,
      ffmpeg: ffmpegVersion,
      filters: Object.fromEntries(["xfade", "zoompan", "zscale", "tonemap", "drawtext", "amix", "alimiter"].map((f) => [f, filters.has(f)])),
      cpus: { visible: cpus().length, available: availableParallelism(), ffmpegThreads: defaultThreads() },
      memory: { totalMb: Math.round(totalmem() / 1048576), freeMb: Math.round(freemem() / 1048576), rssMb: Math.round(process.memoryUsage().rss / 1048576) },
      dataDir: cfg.dataDir,
      dataDirWritable: writable,
      disk: disk ? { totalMb: Math.round((disk.blocks * disk.bsize) / 1048576), freeMb: Math.round((disk.bavail * disk.bsize) / 1048576) } : null,
      queue: { running: queue.current, waiting: queue.size, max: cfg.queueMax },
      jobs: db.countByStatus(),
      keys: db.listKeys().filter((k) => !k.revoked_at).length,
      ttlHours: cfg.ttlHours,
      runningAsRoot: typeof process.getuid === "function" ? process.getuid() === 0 : null,
    };
  });

  /** Autoteste: gera um vídeo com os arquivos de teste do motor (sem upload), para medir no servidor. */
  app.get<{ Querystring: { photos?: string; clips?: string; duration?: string; preset?: string } }>(
    "/v1/admin/selftest",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const photos = Math.min(30, Math.max(0, Number(req.query.photos ?? 8) | 0));
      const clipCount = Math.min(3, Math.max(0, Number(req.query.clips ?? 0) | 0));
      const duration = Math.min(180, Math.max(3, Number(req.query.duration ?? 20) || 20));
      if (photos + clipCount === 0) throw new ApiError(400, "invalid_selftest", "Use photos e/ou clips maiores que zero");
      const assetsDir = join(cfg.dataDir, "selftest-assets");
      const assets = await makeTestAssets(assetsDir);
      const clipFiles = [assets.clips.landscape, assets.clips.rotated, assets.clips.hdr].filter((c): c is string => Boolean(c));
      const paths = new Map<string, string>();
      const items: VideoOptions["items"] = [];
      for (let i = 0; i < photos; i++) {
        const field = `foto${i}`;
        paths.set(field, assets.photos[i % assets.photos.length]!);
        items.push({ file: field, type: "photo" });
      }
      for (let i = 0; i < Math.min(clipCount, clipFiles.length); i++) {
        const field = `clipe${i}`;
        paths.set(field, clipFiles[i]!);
        items.splice(Math.min(items.length, (i + 1) * 2), 0, { file: field, type: "clip", duration: 3, keepAudio: i === 0 });
      }
      paths.set("musica", assets.tone);
      const options: VideoOptions = {
        preset: req.query.preset,
        items,
        audio: { file: "musica", start: 0, loop: true },
        timing: { mode: "fixed", total: duration },
      };
      const id = randomUUID();
      const planned = await submit(id, "admin", options, paths, []);
      return reply.code(202).send({ id, ...planned, statusUrl: `${baseUrl(req)}/v1/admin/jobs/${id}` });
    },
  );

  app.get<{ Params: { id: string } }>("/v1/admin/jobs/:id", { preHandler: requireAdmin }, async (req) => {
    const job = db.job(req.params.id);
    if (!job) throw new ApiError(404, "video_not_found", "Pedido não encontrado");
    return jobView(job, req, true);
  });

  app.get<{ Params: { id: string } }>("/v1/admin/jobs/:id/download", { preHandler: requireAdmin }, async (req, reply) => {
    const job = db.job(req.params.id);
    if (!job) throw new ApiError(404, "video_not_found", "Pedido não encontrado");
    return sendVideo(job, req, reply);
  });

  // ---------------- ciclo de vida ----------------

  await queue.start();
  const timer =
    cfg.cleanupMinutes > 0
      ? setInterval(() => {
          cleanup(db, cfg, queue, log).catch((err: unknown) => log.error({ err }, "falha na limpeza"));
        }, cfg.cleanupMinutes * 60_000)
      : undefined;
  timer?.unref();
  await cleanup(db, cfg, queue, log).catch((err: unknown) => log.error({ err }, "falha na limpeza"));

  return {
    app,
    db,
    queue,
    async close() {
      if (timer) clearInterval(timer);
      await app.close();
      await queue.stop();
      db.close();
    },
  };
}

export { EngineError };
