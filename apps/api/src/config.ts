import { join } from "node:path";
import { ENGINE_ASSETS, PRESETS_DIR, REPO_ROOT } from "@video-editor/engine";

const MB = 1024 * 1024;

export interface ApiConfig {
  port: number;
  host: string;
  /** Pasta do banco, da fila e dos vídeos. Na Railway, o volume montado em /data. */
  dataDir: string;
  /** Chave de administrador. Sem ela, as rotas de administração ficam desligadas. */
  adminKey?: string;
  presetsDir: string;
  assets: { lutsDir: string; fontsDir: string };
  defaultPreset: string;
  /** Horas até o vídeo pronto expirar. */
  ttlHours: number;
  /** Pedidos aguardando na fila, no máximo. */
  queueMax: number;
  rateLimitPerMinute: number;
  createLimitPerMinute: number;
  /** Limites de tamanho por tipo de arquivo e do pedido inteiro, em bytes. */
  limits: { photo: number; clip: number; audio: number; logo: number; total: number; files: number };
  /** Espaço livre mínimo no disco para aceitar um pedido novo. */
  minFreeBytes: number;
  /** Endereço público, para montar links absolutos (opcional; sem ele usa o host da requisição). */
  publicUrl?: string;
  /** Aceita a chave de administrador em `?key=` nas rotas GET de administração (diagnóstico). */
  allowAdminQueryKey: boolean;
  /** Intervalo da limpeza automática, em minutos. */
  cleanupMinutes: number;
}

function int(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  return {
    port: int(env.PORT, 3000),
    host: env.HOST ?? "0.0.0.0",
    dataDir: env.DATA_DIR ?? join(REPO_ROOT, "data"),
    adminKey: env.ADMIN_KEY && env.ADMIN_KEY.length >= 16 ? env.ADMIN_KEY : undefined,
    presetsDir: PRESETS_DIR,
    assets: ENGINE_ASSETS,
    defaultPreset: env.DEFAULT_PRESET ?? "limpo",
    ttlHours: int(env.VIDEO_TTL_HOURS, 24),
    queueMax: int(env.QUEUE_MAX, 20),
    rateLimitPerMinute: int(env.RATE_LIMIT_PER_MINUTE, 300),
    createLimitPerMinute: int(env.CREATE_LIMIT_PER_MINUTE, 10),
    limits: {
      photo: int(env.LIMIT_PHOTO_MB, 15) * MB,
      clip: int(env.LIMIT_CLIP_MB, 200) * MB,
      audio: int(env.LIMIT_AUDIO_MB, 20) * MB,
      logo: int(env.LIMIT_LOGO_MB, 5) * MB,
      total: int(env.LIMIT_TOTAL_MB, 500) * MB,
      files: 45,
    },
    minFreeBytes: int(env.MIN_FREE_MB, 1024) * MB,
    publicUrl: env.PUBLIC_URL?.replace(/\/+$/, ""),
    allowAdminQueryKey: env.ADMIN_QUERY_KEY !== "false",
    cleanupMinutes: int(env.CLEANUP_MINUTES, 10),
  };
}
