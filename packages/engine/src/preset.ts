import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { Ajv, type ErrorObject } from "ajv";
import { EngineError } from "./errors.js";
import { presetSchema } from "./schema.js";
import type { TransitionConfig, TransitionName } from "./transitions.js";

// ajv-i18n é CommonJS sem tipos por idioma; carregado via require.
const localizePtBr = createRequire(import.meta.url)("ajv-i18n/localize/pt-BR") as (
  errors?: ErrorObject[] | null,
) => void;

export type LogoRole = "brand" | "partner";

export type PhotoFilter =
  | { type: "color"; brightness?: number; contrast?: number; saturation?: number; temperature?: number }
  | { type: "curves"; preset: string }
  | { type: "grayscale"; amount?: number }
  | { type: "sepia"; amount?: number }
  | { type: "lut"; file: string }
  | { type: "vignette"; strength?: number }
  | { type: "grain"; amount?: number }
  | { type: "blur"; radius?: number }
  | { type: "sharpen"; amount?: number }
  | { type: "clarity"; amount?: number };

export interface TextStyle {
  font: "sans" | "sans-bold";
  size: number;
  color: string;
  position: "top" | "center" | "bottom";
  box: boolean;
  boxColor: string;
  boxOpacity: number;
}

export interface TitleStyle extends TextStyle {
  start: number;
  duration: number;
  fade: number;
}

export interface CardConfig {
  role: LogoRole;
  duration: number;
  background: string;
  width: number;
  caption?: string;
  captionColor: string;
}

export interface WatermarkConfig {
  role: LogoRole;
  position: "top-left" | "top-center" | "top-right" | "bottom-left" | "bottom-center" | "bottom-right";
  width: number;
  opacity: number;
  margin: number;
}

export interface Preset {
  id: string;
  version: number;
  name: string;
  description?: string;
  photo: {
    fit: "cover" | "contain" | "auto";
    autoThreshold: number;
    background: { type: "blur" | "color"; blur: number; darken: number; color: string };
    filters: PhotoFilter[];
  };
  motion: {
    type: "kenburns" | "none";
    zoomFrom: number;
    zoomTo: number;
    direction: "in" | "out" | "alternate";
    pan: "none" | "left" | "right" | "up" | "down" | "alternate";
  };
  transition: TransitionConfig;
  timing: { perPhotoMin: number; perPhotoMax: number };
  audio: { fadeIn: number; fadeOut: number; volume: number };
  letterbox: number;
  text: { title: TitleStyle | null; caption: TextStyle | null } | null;
  branding: {
    watermark: WatermarkConfig | null;
    intro: CardConfig | null;
    outro: CardConfig | null;
    between: (CardConfig & { every: number }) | null;
  } | null;
}

const ajv = new Ajv({
  allErrors: true,
  useDefaults: true,
  discriminator: true,
  allowUnionTypes: true,
  // o schema traz "default" dentro de oneOf (dicas para o editor) e títulos; sem modo estrito
  strict: false,
});
const validate = ajv.compile(presetSchema);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Herança: objetos são mesclados campo a campo; listas e valores simples são substituídos. */
export function mergePreset(parent: unknown, child: unknown): unknown {
  if (!isPlainObject(parent) || !isPlainObject(child)) return structuredClone(child);
  const out: Record<string, unknown> = structuredClone(parent);
  for (const [key, value] of Object.entries(child)) {
    out[key] = key in out ? mergePreset(out[key], value) : structuredClone(value);
  }
  return out;
}

/** Valida contra o JSON Schema, aplica os padrões e normaliza. */
export function parsePreset(raw: unknown): Preset {
  const data = structuredClone(raw) as Record<string, unknown>;
  if (isPlainObject(data)) delete data.extends;

  if (!validate(data)) {
    localizePtBr(validate.errors);
    const errors = (validate.errors ?? [])
      // erros genéricos de oneOf/anyOf só repetem os específicos
      .filter((e) => !["oneOf", "anyOf", "if"].includes(e.keyword) || validate.errors!.length === 1)
      .map((e) => {
        const extra = e.keyword === "additionalProperties" ? ` ("${e.params.additionalProperty as string}")` : "";
        return `${e.instancePath || "/"}: ${e.message ?? "inválido"}${extra}`;
      });
    const unique = [...new Set(errors)];
    throw new EngineError("invalid_preset", `Preset inválido:\n  - ${unique.join("\n  - ")}`, { errors: unique });
  }

  const p = data as unknown as Preset & {
    transition: Partial<TransitionConfig> & { type?: TransitionName; duration: number };
  };
  const { type, types, ...rest } = p.transition;
  if (type !== undefined && types !== undefined) {
    throw new EngineError("invalid_preset", 'Preset inválido:\n  - /transition: use "type" ou "types", não os dois', {
      errors: ['/transition: use "type" ou "types", não os dois'],
    });
  }
  p.transition = {
    ...rest,
    types: types ?? [type!],
    order: rest.order ?? "cycle",
    seed: rest.seed ?? 1,
  };

  const fail = (msg: string): never => {
    throw new EngineError("invalid_preset", `Preset inválido:\n  - ${msg}`, { errors: [msg] });
  };
  if (p.timing.perPhotoMin > p.timing.perPhotoMax) {
    fail("/timing: perPhotoMin não pode ser maior que perPhotoMax");
  }
  const b = p.branding;
  if (b) {
    for (const [name, c] of [["intro", b.intro], ["outro", b.outro], ["between", b.between]] as const) {
      if (c && c.duration < 2 * p.transition.duration + 0.3) {
        fail(`/branding/${name}/duration: deve ser maior que duas vezes a duração da transição + 0,3 s`);
      }
    }
  }
  return p;
}

export interface LoadPresetOptions {
  /** Pasta onde procurar o preset pai (extends). Padrão: a pasta do próprio arquivo. */
  presetsDir?: string;
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (err) {
    throw new EngineError("invalid_preset", `Não foi possível ler o preset "${file}": ${(err as Error).message}`);
  }
}

export async function loadPreset(file: string, options: LoadPresetOptions = {}): Promise<Preset> {
  const raw = await readJson(file);
  if (!isPlainObject(raw) || typeof raw.extends !== "string") return parsePreset(raw);

  const parentId = raw.extends;
  if (!/^[a-z0-9-]+$/.test(parentId)) {
    throw new EngineError("invalid_preset", `"extends" inválido em "${file}"`);
  }
  const candidates = [join(dirname(file), `${parentId}.json`)];
  if (options.presetsDir) candidates.push(join(options.presetsDir, `${parentId}.json`));

  let parent: unknown;
  for (const candidate of candidates) {
    try {
      parent = JSON.parse(await readFile(candidate, "utf8"));
      break;
    } catch {
      // tenta o próximo
    }
  }
  if (parent === undefined) {
    throw new EngineError("invalid_preset", `Preset pai "${parentId}" não encontrado (extends em "${file}")`);
  }
  if (isPlainObject(parent) && parent.extends !== undefined) {
    throw new EngineError(
      "invalid_preset",
      `Herança em cadeia não é permitida: "${parentId}" também usa extends (em "${file}")`,
    );
  }
  const merged = mergePreset(parent, raw) as Record<string, unknown>;
  // "type" e "types" são alternativos: o que o filho definir substitui o do pai.
  const childTransition = raw.transition;
  if (isPlainObject(childTransition) && isPlainObject(merged.transition)) {
    if ("types" in childTransition && !("type" in childTransition)) delete merged.transition.type;
    if ("type" in childTransition && !("types" in childTransition)) delete merged.transition.types;
  }
  return parsePreset(merged);
}
