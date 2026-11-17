import { mkdir, rm, stat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { EngineError, getPlatform, renderVideo, type Preset, type RenderItem } from "@video-editor/engine";
import type { ApiConfig } from "./config.js";
import type { Db, JobRow } from "./db.js";

/** Pedido resolvido e guardado no banco: tudo que o render precisa, com caminhos locais. */
export interface StoredRequest {
  items: RenderItem[];
  preset: Preset;
  platform: string;
  timing: { mode: "audio" | "fixed"; total?: number };
  audio?: { file: string; start?: number | string; end?: number | string; duration?: number | string; loop?: boolean };
  logos?: { role: "brand" | "partner"; file: string }[];
  title?: string;
}

export interface Logger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export function jobDir(cfg: ApiConfig, id: string): string {
  return join(cfg.dataDir, "jobs", id);
}
export function inputDir(cfg: ApiConfig, id: string): string {
  return join(jobDir(cfg, id), "in");
}
export function outputFile(cfg: ApiConfig, id: string): string {
  return join(jobDir(cfg, id), "video.mp4");
}

/**
 * Fila em processo: um render por vez (o FFmpeg já usa todos os núcleos permitidos).
 * O estado fica no SQLite; a ordem em memória é refeita a partir dele ao iniciar.
 */
export class JobQueue {
  private pending: string[] = [];
  private running: string | null = null;
  private stopped = false;
  private idle: Promise<void> = Promise.resolve();
  private finishIdle: (() => void) | null = null;

  constructor(
    private readonly db: Db,
    private readonly cfg: ApiConfig,
    private readonly log: Logger,
  ) {}

  /** Recupera o estado depois de um reinício e começa a processar. */
  async start(): Promise<void> {
    await mkdir(join(this.cfg.dataDir, "jobs"), { recursive: true });
    const now = Date.now();
    for (const job of this.db.jobsByStatus("processing")) {
      this.db.update(job.id, {
        status: "failed",
        finished_at: now,
        error_json: JSON.stringify({
          code: "server_restarted",
          message: "O servidor reiniciou durante o render. Envie o pedido de novo.",
        }),
      });
      await rm(jobDir(this.cfg, job.id), { recursive: true, force: true });
      this.log.warn({ job: job.id }, "pedido interrompido por reinício");
    }
    this.pending = this.db.jobsByStatus("queued").map((j) => j.id);
    if (this.pending.length) this.log.info({ count: this.pending.length }, "retomando fila");
    this.kick();
  }

  get size(): number {
    return this.pending.length;
  }

  get current(): string | null {
    return this.running;
  }

  isFull(): boolean {
    return this.pending.length >= this.cfg.queueMax;
  }

  enqueue(id: string): void {
    this.pending.push(id);
    this.kick();
  }

  /** Posição na fila (1 = o próximo), ou 0 se não estiver aguardando. */
  position(id: string): number {
    return this.pending.indexOf(id) + 1;
  }

  /** Tira um pedido da fila, se ainda não começou. */
  remove(id: string): boolean {
    const i = this.pending.indexOf(id);
    if (i < 0) return false;
    this.pending.splice(i, 1);
    return true;
  }

  /** Para de pegar pedidos novos e espera o atual terminar. */
  async stop(): Promise<void> {
    this.stopped = true;
    await this.idle;
  }

  private kick(): void {
    if (this.running || this.stopped) return;
    const id = this.pending.shift();
    if (!id) return;
    this.running = id;
    this.idle = new Promise((resolve) => (this.finishIdle = resolve));
    void this.process(id).finally(() => {
      this.running = null;
      this.finishIdle?.();
      this.kick();
    });
  }

  private async process(id: string): Promise<void> {
    const job = this.db.job(id);
    if (!job || job.status !== "queued") return;
    const started = Date.now();
    this.db.update(id, { status: "processing", started_at: started, progress: 0 });
    this.log.info({ job: id }, "render iniciado");

    let lastSaved = 0;
    let lastFraction = 0;
    const onProgress = (fraction: number) => {
      const now = Date.now();
      if (fraction - lastFraction < 0.01 && now - lastSaved < 2000) return;
      lastSaved = now;
      lastFraction = fraction;
      this.db.update(id, { progress: Math.min(0.99, Math.max(0, fraction)) });
    };

    try {
      const req = JSON.parse(job.request_json) as StoredRequest;
      const output = outputFile(this.cfg, id);
      const result = await renderVideo({
        ...req,
        platform: getPlatform(req.platform),
        assets: this.cfg.assets,
        output,
        onProgress,
      });
      const bytes = (await stat(output)).size;
      const finished = Date.now();
      const warnings = [...new Set([...(JSON.parse(job.warnings_json) as string[]), ...result.warnings])];
      this.db.update(id, {
        status: "done",
        progress: 1,
        finished_at: finished,
        expires_at: finished + this.cfg.ttlHours * 3600_000,
        output_bytes: bytes,
        warnings_json: JSON.stringify(warnings),
        result_json: JSON.stringify({
          duration: result.duration,
          width: result.width,
          height: result.height,
          fps: result.fps,
          itemCount: result.itemCount,
          fits: result.fits,
          clips: result.clips,
          transitions: result.transitions,
          audioSegment: result.audioSegment,
          stats: {
            prepareSeconds: result.stats.prepareSeconds,
            renderSeconds: result.stats.renderSeconds,
            totalSeconds: result.stats.totalSeconds,
            renderRatio: result.stats.renderRatio,
            outputBytes: bytes,
            ffmpegMaxRssMb: result.stats.ffmpeg.maxRssMb,
          },
        }),
      });
      this.log.info({ job: id, seconds: (finished - started) / 1000, bytes }, "render concluído");
    } catch (err) {
      const isEngine = err instanceof EngineError;
      const error = isEngine
        ? { code: err.code, message: err.message, internal: err.details }
        : { code: "internal_error", message: "Erro interno durante o render.", internal: { message: String(err) } };
      this.db.update(id, { status: "failed", finished_at: Date.now(), error_json: JSON.stringify(error) });
      this.log.error({ job: id, err: isEngine ? { code: err.code, message: err.message, details: err.details } : err }, "render falhou");
      await rm(outputFile(this.cfg, id), { force: true });
    } finally {
      // As entradas não são mais necessárias: só o vídeo final fica guardado até expirar.
      await rm(inputDir(this.cfg, id), { recursive: true, force: true });
    }
  }
}

/** Limpeza periódica: vídeos vencidos, pastas órfãs e histórico antigo. */
export async function cleanup(db: Db, cfg: ApiConfig, queue: JobQueue, log: Logger, now = Date.now()): Promise<void> {
  for (const job of db.expiredJobs(now)) {
    await rm(jobDir(cfg, job.id), { recursive: true, force: true });
    db.update(job.id, { status: "expired" });
  }
  // Pastas sem pedido ativo (por exemplo, upload interrompido por queda do servidor).
  const root = join(cfg.dataDir, "jobs");
  let entries: string[] = [];
  try {
    entries = await readdir(root);
  } catch {
    return;
  }
  for (const name of entries) {
    const job = db.job(name);
    const active = job && (job.status === "queued" || job.status === "processing" || job.status === "done");
    if (active || name === queue.current) continue;
    // Uploads em andamento ainda não têm registro: só remove pastas com mais de 1 hora.
    if (!job) {
      const info = await stat(join(root, name)).catch(() => undefined);
      if (info && now - info.mtimeMs < 3600_000) continue;
    }
    await rm(join(root, name), { recursive: true, force: true });
  }
  const purged = db.purgeOld(now - 30 * 24 * 3600_000);
  if (purged) log.info({ purged }, "histórico antigo removido");
}

export function isTerminal(job: JobRow): boolean {
  return job.status !== "queued" && job.status !== "processing";
}
