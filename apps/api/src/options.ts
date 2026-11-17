import { Ajv, type ErrorObject } from "ajv";
import { ALL_TRANSITIONS } from "@video-editor/engine";
import { ApiError } from "./errors.js";

/** Nome de campo do multipart que carrega um arquivo. */
const field = { type: "string", pattern: "^[A-Za-z0-9_.-]{1,64}$" } as const;
const time = { type: ["number", "string"], minimum: 0, maxLength: 16 } as const;

/**
 * Formato do campo `options` (JSON) de POST /v1/videos. Os arquivos vão em outros
 * campos do multipart e são referenciados aqui pelo nome do campo.
 * As regras finas (faixas de tempo, limites de clipes, textos) ficam no motor.
 */
export const optionsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: {
    preset: { type: "string", pattern: "^[a-z0-9-]{1,64}$" },
    platform: { type: "string", maxLength: 64 },
    items: {
      type: "array",
      minItems: 1,
      maxItems: 30,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["file"],
        properties: {
          file: field,
          type: { type: "string", enum: ["photo", "clip"] },
          focus: {
            type: "object",
            additionalProperties: false,
            required: ["x", "y"],
            properties: { x: { type: "number", minimum: 0, maximum: 1 }, y: { type: "number", minimum: 0, maximum: 1 } },
          },
          caption: { type: "string", maxLength: 500 },
          start: time,
          end: time,
          duration: time,
          keepAudio: { type: "boolean" },
          volume: { type: "number", minimum: 0, maximum: 2 },
        },
      },
    },
    audio: {
      type: "object",
      additionalProperties: false,
      properties: {
        file: field,
        libraryId: { type: "string", maxLength: 64 },
        mood: { type: "string", maxLength: 64 },
        start: time,
        end: time,
        duration: time,
        loop: { type: "boolean" },
      },
    },
    timing: {
      type: "object",
      additionalProperties: false,
      properties: {
        mode: { type: "string", enum: ["audio", "fixed"] },
        total: { type: "number", exclusiveMinimum: 0, maximum: 600 },
      },
    },
    logos: {
      type: "array",
      maxItems: 2,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["role", "file"],
        properties: { role: { type: "string", enum: ["brand", "partner"] }, file: field },
      },
    },
    title: { type: "string", maxLength: 500 },
    overrides: {
      type: "object",
      additionalProperties: false,
      properties: {
        transition: {
          type: "object",
          additionalProperties: false,
          properties: {
            type: { type: "string", enum: ALL_TRANSITIONS },
            types: { type: "array", minItems: 1, maxItems: 20, items: { type: "string", enum: ALL_TRANSITIONS } },
            order: { type: "string", enum: ["cycle", "random"] },
            seed: { type: "integer", minimum: 0, maximum: 4294967295 },
            duration: { type: "number", minimum: 0, maximum: 3 },
          },
        },
        audio: {
          type: "object",
          additionalProperties: false,
          properties: {
            volume: { type: "number" },
            fadeIn: { type: "number" },
            fadeOut: { type: "number" },
            clipDucking: { type: "number" },
          },
        },
        photo: {
          type: "object",
          additionalProperties: false,
          properties: { fit: { type: "string", enum: ["cover", "contain", "auto"] } },
        },
      },
    },
    callbackUrl: { type: "string", maxLength: 2048, pattern: "^https://" },
  },
} as const;

type Time = number | string;

export interface VideoOptions {
  preset?: string;
  platform?: string;
  items: {
    file: string;
    type?: "photo" | "clip";
    focus?: { x: number; y: number };
    caption?: string;
    start?: Time;
    end?: Time;
    duration?: Time;
    keepAudio?: boolean;
    volume?: number;
  }[];
  audio?: { file?: string; libraryId?: string; mood?: string; start?: Time; end?: Time; duration?: Time; loop?: boolean };
  timing?: { mode?: "audio" | "fixed"; total?: number };
  logos?: { role: "brand" | "partner"; file: string }[];
  title?: string;
  overrides?: {
    transition?: { type?: string; types?: string[]; order?: "cycle" | "random"; seed?: number; duration?: number };
    audio?: { volume?: number; fadeIn?: number; fadeOut?: number; clipDucking?: number };
    photo?: { fit?: "cover" | "contain" | "auto" };
  };
  callbackUrl?: string;
}

const ajv = new Ajv({ allErrors: false, strict: false });
const validate = ajv.compile<VideoOptions>(optionsSchema);

function describe(err: ErrorObject): string {
  const where = err.instancePath ? `options${err.instancePath.replace(/\/(\d+)/g, "[$1]").replace(/\//g, ".")}` : "options";
  switch (err.keyword) {
    case "required":
      return `${where}: campo obrigatório "${(err.params as { missingProperty: string }).missingProperty}" ausente`;
    case "additionalProperties":
      return `${where}: campo desconhecido "${(err.params as { additionalProperty: string }).additionalProperty}"`;
    case "enum":
      return `${where}: valor inválido (aceitos: ${((err.params as { allowedValues: unknown[] }).allowedValues ?? []).slice(0, 8).join(", ")}${((err.params as { allowedValues: unknown[] }).allowedValues ?? []).length > 8 ? "..." : ""})`;
    case "type": {
      const t = String((err.params as { type: string | string[] }).type);
      if (t === "number,string") return `${where}: use segundos (número) ou "mm:ss"`;
      return `${where}: deve ser do tipo ${t}`;
    }
    case "minItems":
      return `${where}: informe ao menos ${(err.params as { limit: number }).limit} item(ns)`;
    case "maxItems":
      return `${where}: máximo de ${(err.params as { limit: number }).limit} item(ns)`;
    case "maxLength":
      return `${where}: máximo de ${(err.params as { limit: number }).limit} caracteres`;
    case "pattern":
      return where.endsWith("callbackUrl") ? `${where}: deve ser um endereço https://` : `${where}: formato inválido`;
    case "minimum":
    case "maximum":
    case "exclusiveMinimum":
      return `${where}: deve ser ${err.keyword === "maximum" ? "no máximo" : "no mínimo"} ${(err.params as { limit: number }).limit}`;
    default:
      return `${where}: valor inválido`;
  }
}

export function parseOptions(text: string | undefined): VideoOptions {
  if (text === undefined || text.trim() === "") {
    throw new ApiError(400, "missing_options", 'Envie o campo "options" (JSON) no multipart');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ApiError(400, "invalid_json", 'O campo "options" não é um JSON válido');
  }
  if (!validate(raw)) {
    const err = validate.errors?.[0];
    throw new ApiError(400, "invalid_options", err ? describe(err) : "options inválido");
  }
  if (raw.audio && raw.audio.file === undefined && raw.audio.libraryId === undefined && raw.audio.mood === undefined) {
    throw new ApiError(400, "invalid_options", "options.audio: informe file (upload) ou, a partir da Fase 2B, libraryId/mood");
  }
  if (raw.audio && [raw.audio.file, raw.audio.libraryId, raw.audio.mood].filter((v) => v !== undefined).length > 1) {
    throw new ApiError(400, "invalid_options", "options.audio: use só um entre file, libraryId e mood");
  }
  const roles = (raw.logos ?? []).map((l) => l.role);
  if (new Set(roles).size !== roles.length) {
    throw new ApiError(400, "invalid_options", "options.logos: cada papel (brand, partner) aparece uma vez só");
  }
  if (raw.overrides?.transition?.type && raw.overrides.transition.types) {
    throw new ApiError(400, "invalid_options", "options.overrides.transition: use type ou types, não os dois");
  }
  return raw;
}

/** Campos de arquivo referenciados pelas opções, com o uso de cada um. */
export function referencedFiles(opts: VideoOptions): Map<string, "item" | "audio" | "logo"> {
  const refs = new Map<string, "item" | "audio" | "logo">();
  const add = (name: string, use: "item" | "audio" | "logo", where: string) => {
    const prev = refs.get(name);
    if (prev && prev !== use) {
      throw new ApiError(400, "invalid_options", `${where}: o arquivo "${name}" já é usado como ${prev}`);
    }
    refs.set(name, use);
  };
  opts.items.forEach((it, i) => add(it.file, "item", `options.items[${i}].file`));
  if (opts.audio?.file) add(opts.audio.file, "audio", "options.audio.file");
  opts.logos?.forEach((l, i) => add(l.file, "logo", `options.logos[${i}].file`));
  return refs;
}
