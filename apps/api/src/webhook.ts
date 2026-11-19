import { createHmac } from "node:crypto";
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import type { ApiConfig } from "./config.js";
import type { Db, JobRow } from "./db.js";
import { ApiError } from "./errors.js";
import type { Logger } from "./jobs.js";

/**
 * Aviso por webhook quando um vídeo termina (pronto ou com falha).
 *
 * Assinatura: header `X-Webhook-Signature: t=<unix>,v1=<hex>`, em que `v1` é o
 * HMAC-SHA256 de `"<t>.<corpo>"` com o segredo da chave (`whsec_...`).
 * O destinatário deve recalcular, comparar em tempo constante e recusar `t` antigo.
 */
export function signPayload(secret: string, timestamp: number, body: string): string {
  const mac = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return `t=${timestamp},v1=${mac}`;
}

const PRIVATE = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  PRIVATE.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  PRIVATE.addSubnet(net, prefix, "ipv6");
}

function isPrivate(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return PRIVATE.check(address, "ipv4");
  if (family === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    if (mapped) return PRIVATE.check(mapped[1]!, "ipv4");
    return PRIVATE.check(address, "ipv6");
  }
  return true;
}

/**
 * Confere o endereço do webhook: https e destino público (evita que o servidor
 * seja usado para alcançar a rede interna). Em testes, `webhookAllowInsecure` libera.
 */
export async function checkCallbackUrl(raw: string, cfg: ApiConfig): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ApiError(400, "invalid_callback_url", "callbackUrl não é um endereço válido");
  }
  if (cfg.webhookAllowInsecure) {
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new ApiError(400, "invalid_callback_url", "callbackUrl deve usar http ou https");
    }
    return url;
  }
  if (url.protocol !== "https:") throw new ApiError(400, "invalid_callback_url", "callbackUrl deve usar https://");
  if (url.username || url.password) {
    throw new ApiError(400, "invalid_callback_url", "callbackUrl não pode ter usuário e senha no endereço");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let addresses: string[];
  try {
    addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  } catch {
    throw new ApiError(400, "invalid_callback_url", `callbackUrl: não foi possível resolver "${host}"`);
  }
  if (addresses.length === 0 || addresses.some(isPrivate)) {
    throw new ApiError(400, "invalid_callback_url", "callbackUrl aponta para um endereço interno ou reservado");
  }
  return url;
}

export interface WebhookPayload {
  event: "video.done" | "video.failed";
  id: string;
  status: string;
  createdAt: string;
  finishedAt: string | null;
  expiresAt: string | null;
  duration: number | null;
  sizeBytes: number | null;
  downloadUrl: string | null;
  warnings: string[];
  error: { code: string; message: string } | null;
}

export function buildPayload(job: JobRow, cfg: ApiConfig): WebhookPayload {
  const iso = (t: number | null) => (t ? new Date(t).toISOString() : null);
  const result = job.result_json ? (JSON.parse(job.result_json) as { duration?: number }) : null;
  const error = job.error_json ? (JSON.parse(job.error_json) as { code: string; message: string }) : null;
  const base = cfg.publicUrl ?? job.base_url;
  return {
    event: job.status === "done" ? "video.done" : "video.failed",
    id: job.id,
    status: job.status,
    createdAt: new Date(job.created_at).toISOString(),
    finishedAt: iso(job.finished_at),
    expiresAt: iso(job.expires_at),
    duration: result?.duration ?? null,
    sizeBytes: job.output_bytes,
    downloadUrl: job.status === "done" && base ? `${base}/v1/videos/${job.id}/download` : null,
    warnings: JSON.parse(job.warnings_json) as string[],
    error: error ? { code: error.code, message: error.message } : null,
  };
}

/** Envia os avisos com novas tentativas; o estado fica no SQLite e sobrevive a reinícios. */
export class WebhookSender {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private current: Promise<void> = Promise.resolve();

  constructor(
    private readonly db: Db,
    private readonly cfg: ApiConfig,
    private readonly log: Logger,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  start(intervalMs = 2000): void {
    this.timer = setInterval(() => this.kick(), intervalMs);
    this.timer.unref();
    this.kick();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.current;
  }

  /** Agenda o aviso de um pedido que terminou (se ele pediu webhook). */
  schedule(jobId: string): void {
    const job = this.db.job(jobId);
    if (!job?.callback_url || job.kind !== "video") return;
    if (job.status !== "done" && job.status !== "failed") return;
    this.db.update(jobId, { webhook_status: "pending", webhook_attempts: 0, webhook_next_at: Date.now(), webhook_last_error: null });
    this.kick();
  }

  /** Processa os avisos vencidos (um lote por vez). */
  kick(): void {
    if (this.running) return;
    this.running = true;
    this.current = this.drain()
      .catch((err: unknown) => this.log.error({ err }, "falha no envio de webhooks"))
      .finally(() => {
        this.running = false;
      });
  }

  private async drain(): Promise<void> {
    for (const job of this.db.dueWebhooks(Date.now())) await this.deliver(job);
  }

  private async deliver(job: JobRow): Promise<void> {
    const attempt = job.webhook_attempts + 1;
    const key = this.db.key(job.key_id);
    let error: string | null = null;
    if (!key?.webhook_secret) {
      error = "a chave do pedido não tem segredo de webhook";
    } else {
      try {
        const url = await checkCallbackUrl(job.callback_url!, this.cfg);
        const body = JSON.stringify(buildPayload(job, this.cfg));
        const ts = Math.floor(Date.now() / 1000);
        const res = await this.fetchImpl(url, {
          method: "POST",
          redirect: "manual",
          signal: AbortSignal.timeout(this.cfg.webhookTimeoutMs),
          headers: {
            "content-type": "application/json",
            "user-agent": "video-editor-api-webhook/1",
            "x-webhook-id": job.id,
            "x-webhook-event": job.status === "done" ? "video.done" : "video.failed",
            "x-webhook-attempt": String(attempt),
            "x-webhook-signature": signPayload(key.webhook_secret, ts, body),
          },
          body,
        });
        await res.body?.cancel().catch(() => undefined);
        if (res.status < 200 || res.status >= 300) error = `resposta HTTP ${res.status}`;
      } catch (err) {
        error = err instanceof ApiError ? err.message : (err as Error).name === "TimeoutError" ? "tempo esgotado" : (err as Error).message;
      }
    }

    if (error === null) {
      this.db.update(job.id, { webhook_status: "delivered", webhook_attempts: attempt, webhook_next_at: null, webhook_last_error: null });
      this.log.info({ job: job.id, attempt }, "webhook entregue");
      return;
    }
    const delays = this.cfg.webhookRetryDelaysMs;
    const retry = attempt <= delays.length && key?.webhook_secret;
    this.db.update(job.id, {
      webhook_status: retry ? "pending" : "failed",
      webhook_attempts: attempt,
      webhook_next_at: retry ? Date.now() + delays[attempt - 1]! : null,
      webhook_last_error: error,
    });
    this.log.warn({ job: job.id, attempt, error, retry: Boolean(retry) }, "webhook não entregue");
  }
}
