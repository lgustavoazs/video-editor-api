import { EngineError } from "./errors.js";

export interface PlatformProfile {
  id: string;
  width: number;
  height: number;
  fps: number;
  /** Duração máxima do vídeo, em segundos. */
  maxDuration: number;
}

/**
 * ATENÇÃO: os valores de maxDuration são PROVISÓRIOS (conservadores).
 * Devem ser conferidos nas documentações oficiais de cada plataforma na Fase 1A.
 */
const PROFILES: PlatformProfile[] = [
  { id: "instagram_reels", width: 1080, height: 1920, fps: 30, maxDuration: 60 },
  { id: "tiktok", width: 1080, height: 1920, fps: 30, maxDuration: 60 },
  { id: "youtube_shorts", width: 1080, height: 1920, fps: 30, maxDuration: 60 },
  { id: "facebook_reels", width: 1080, height: 1920, fps: 30, maxDuration: 60 },
  { id: "facebook_feed", width: 1080, height: 1350, fps: 30, maxDuration: 60 },
];

export function listPlatforms(): PlatformProfile[] {
  return PROFILES.map((p) => ({ ...p }));
}

export function getPlatform(id: string): PlatformProfile {
  const p = PROFILES.find((x) => x.id === id);
  if (!p) {
    throw new EngineError("unknown_platform", `Plataforma desconhecida: "${id}"`, {
      available: PROFILES.map((x) => x.id),
    });
  }
  return { ...p };
}
