import { readFile } from "node:fs/promises";
import { EngineError } from "./errors.js";

export interface ColorFilter {
  type: "color";
  /** -1..1 (0 = neutro) */
  brightness?: number;
  /** 0..2 (1 = neutro) */
  contrast?: number;
  /** 0..3 (1 = neutro) */
  saturation?: number;
  /** -1 (frio) .. 1 (quente), 0 = neutro */
  temperature?: number;
}
export interface VignetteFilter {
  type: "vignette";
  /** 0..1 */
  strength: number;
}
export interface GrainFilter {
  type: "grain";
  /** 0..100 */
  amount: number;
}
export type PhotoFilter = ColorFilter | VignetteFilter | GrainFilter;

export interface Preset {
  id: string;
  version: number;
  name: string;
  photo: { fit: "cover"; filters: PhotoFilter[] };
  motion: {
    type: "kenburns" | "none";
    zoomFrom: number;
    zoomTo: number;
    direction: "in" | "out" | "alternate";
  };
  transition: { type: "fade"; duration: number };
  timing: { perPhotoMin: number; perPhotoMax: number };
  audio: { fadeIn: number; fadeOut: number; volume: number };
}

function fail(path: string, msg: string): never {
  throw new EngineError("invalid_preset", `Preset inválido em "${path}": ${msg}`, { path });
}

function num(v: unknown, path: string, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) fail(path, "deve ser um número");
  if (v < min || v > max) fail(path, `deve estar entre ${min} e ${max}`);
  return v;
}

function optNum(v: unknown, path: string, min: number, max: number, def: number): number {
  return v === undefined ? def : num(v, path, min, max);
}

function oneOf<T extends string>(v: unknown, path: string, allowed: readonly T[]): T {
  if (typeof v !== "string" || !allowed.includes(v as T)) {
    fail(path, `deve ser um de: ${allowed.join(", ")}`);
  }
  return v as T;
}

function obj(v: unknown, path: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) fail(path, "deve ser um objeto");
  return v as Record<string, unknown>;
}

function parseFilter(raw: unknown, path: string): PhotoFilter {
  const f = obj(raw, path);
  const type = oneOf(f.type, `${path}.type`, ["color", "vignette", "grain"] as const);
  switch (type) {
    case "color":
      return {
        type,
        brightness: optNum(f.brightness, `${path}.brightness`, -1, 1, 0),
        contrast: optNum(f.contrast, `${path}.contrast`, 0, 2, 1),
        saturation: optNum(f.saturation, `${path}.saturation`, 0, 3, 1),
        temperature: optNum(f.temperature, `${path}.temperature`, -1, 1, 0),
      };
    case "vignette":
      return { type, strength: num(f.strength, `${path}.strength`, 0, 1) };
    case "grain":
      return { type, amount: num(f.amount, `${path}.amount`, 0, 100) };
  }
}

/**
 * Validação mínima da Fase 0. Na Fase 1A é substituída por JSON Schema
 * (o mesmo schema alimenta o editor visual).
 */
export function parsePreset(raw: unknown): Preset {
  const p = obj(raw, "$");
  if (typeof p.id !== "string" || !/^[a-z0-9-]+$/.test(p.id)) {
    fail("id", "deve conter apenas letras minúsculas, números e hífen");
  }
  if (typeof p.name !== "string" || p.name.length === 0) fail("name", "obrigatório");

  const photo = obj(p.photo, "photo");
  const filtersRaw = photo.filters ?? [];
  if (!Array.isArray(filtersRaw)) fail("photo.filters", "deve ser uma lista");

  const motion = obj(p.motion, "motion");
  const transition = obj(p.transition, "transition");
  const timing = obj(p.timing, "timing");
  const audio = obj(p.audio ?? {}, "audio");

  const preset: Preset = {
    id: p.id,
    version: num(p.version, "version", 1, 1_000_000),
    name: p.name,
    photo: {
      fit: oneOf(photo.fit, "photo.fit", ["cover"] as const),
      filters: filtersRaw.map((f, i) => parseFilter(f, `photo.filters[${i}]`)),
    },
    motion: {
      type: oneOf(motion.type, "motion.type", ["kenburns", "none"] as const),
      zoomFrom: optNum(motion.zoomFrom, "motion.zoomFrom", 1, 3, 1),
      zoomTo: optNum(motion.zoomTo, "motion.zoomTo", 1, 3, 1),
      direction: oneOf(motion.direction ?? "in", "motion.direction", ["in", "out", "alternate"] as const),
    },
    transition: {
      type: oneOf(transition.type, "transition.type", ["fade"] as const),
      duration: num(transition.duration, "transition.duration", 0, 3),
    },
    timing: {
      perPhotoMin: num(timing.perPhotoMin, "timing.perPhotoMin", 0.2, 60),
      perPhotoMax: num(timing.perPhotoMax, "timing.perPhotoMax", 0.2, 60),
    },
    audio: {
      fadeIn: optNum(audio.fadeIn, "audio.fadeIn", 0, 10, 0),
      fadeOut: optNum(audio.fadeOut, "audio.fadeOut", 0, 10, 0),
      volume: optNum(audio.volume, "audio.volume", 0, 2, 1),
    },
  };

  if (preset.timing.perPhotoMin > preset.timing.perPhotoMax) {
    fail("timing", "perPhotoMin não pode ser maior que perPhotoMax");
  }
  return preset;
}

export async function loadPreset(file: string): Promise<Preset> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, "utf8"));
  } catch (err) {
    throw new EngineError("invalid_preset", `Não foi possível ler o preset "${file}": ${(err as Error).message}`);
  }
  return parsePreset(raw);
}
