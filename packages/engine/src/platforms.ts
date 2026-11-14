import { EngineError } from "./errors.js";

/** Margens (frações do quadro) que a interface da plataforma cobre. */
export interface SafeZone {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface PlatformProfile {
  id: string;
  width: number;
  height: number;
  fps: number;
  /** Duração máxima aceita por este serviço para o perfil, em segundos. */
  maxDuration: number;
  safeZone: SafeZone;
}

/**
 * Durações e zonas seguras conferidas em novembro de 2026.
 *
 * - maxDuration: Reels e Shorts aceitam até 3 minutos; TikTok e Facebook aceitam mais,
 *   mas o serviço limita tudo a 180 s por ser voltado a vídeos curtos.
 * - safeZone: as plataformas só publicam zonas seguras para anúncios, que são mais
 *   conservadoras que a interface de posts comuns. Reels: guia de anúncios da Meta
 *   (14% no topo, 35% embaixo, 6% nas laterais). TikTok e Shorts: valores em pixels
 *   publicados para anúncios verticais, convertidos para fração de 1080x1920.
 *
 * As plataformas mudam esses números com frequência: revisar periodicamente.
 */
const PROFILES: PlatformProfile[] = [
  {
    id: "instagram_reels", width: 1080, height: 1920, fps: 30, maxDuration: 180,
    safeZone: { top: 0.14, bottom: 0.35, left: 0.06, right: 0.06 },
  },
  {
    id: "facebook_reels", width: 1080, height: 1920, fps: 30, maxDuration: 180,
    safeZone: { top: 0.14, bottom: 0.35, left: 0.06, right: 0.06 },
  },
  {
    id: "tiktok", width: 1080, height: 1920, fps: 30, maxDuration: 180,
    safeZone: { top: 0.07, bottom: 0.25, left: 0.06, right: 0.14 },
  },
  {
    id: "youtube_shorts", width: 1080, height: 1920, fps: 30, maxDuration: 180,
    safeZone: { top: 0.15, bottom: 0.35, left: 0.045, right: 0.18 },
  },
  {
    id: "facebook_feed", width: 1080, height: 1350, fps: 30, maxDuration: 180,
    safeZone: { top: 0.04, bottom: 0.04, left: 0.04, right: 0.04 },
  },
];

export function listPlatforms(): PlatformProfile[] {
  return PROFILES.map((p) => ({ ...p, safeZone: { ...p.safeZone } }));
}

export function getPlatform(id: string): PlatformProfile {
  const p = PROFILES.find((x) => x.id === id);
  if (!p) {
    throw new EngineError("unknown_platform", `Plataforma desconhecida: "${id}"`, {
      available: PROFILES.map((x) => x.id),
    });
  }
  return { ...p, safeZone: { ...p.safeZone } };
}
