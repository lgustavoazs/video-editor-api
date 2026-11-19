import { randomInt } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { Ajv } from "ajv";
import { probe } from "@video-editor/engine";
import { ApiError } from "./errors.js";

export interface Track {
  id: string;
  name: string;
  file: string;
  moods: string[];
  license: string;
  source?: string;
  attribution?: string;
}

const slug = { type: "string", pattern: "^[a-z0-9-]{1,64}$" } as const;
const librarySchema = {
  type: "object",
  additionalProperties: false,
  required: ["tracks"],
  properties: {
    $comment: { type: "string" },
    tracks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "name", "file", "moods", "license"],
        properties: {
          id: slug,
          name: { type: "string", minLength: 1, maxLength: 120 },
          file: { type: "string", pattern: "^tracks/[A-Za-z0-9._-]+$" },
          moods: { type: "array", minItems: 1, maxItems: 10, items: slug },
          license: { type: "string", minLength: 1, maxLength: 200 },
          source: { type: "string", maxLength: 500 },
          attribution: { type: "string", maxLength: 300 },
        },
      },
    },
  },
} as const;

const validate = new Ajv({ allErrors: false, strict: false }).compile<{ tracks: Track[] }>(librarySchema);

/** Gerador determinístico (mulberry32): a mesma semente sempre escolhe a mesma faixa. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Catálogo de músicas do repositório (`audio/library.json`). */
export class AudioLibrary {
  private tracks: Track[] = [];
  private durations = new Map<string, number>();

  constructor(private readonly dir: string) {}

  /** Lê e confere o catálogo. Erro aqui impede o servidor de iniciar com catálogo quebrado. */
  async load(): Promise<void> {
    const file = join(this.dir, "library.json");
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(file, "utf8"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        this.tracks = [];
        return;
      }
      throw new Error(`Catálogo de áudio ilegível (${file}): ${(err as Error).message}`);
    }
    if (!validate(raw)) {
      const e = validate.errors?.[0];
      throw new Error(`Catálogo de áudio inválido (${file}): ${e?.instancePath || "/"} ${e?.message ?? ""}`);
    }
    const ids = new Set<string>();
    for (const t of raw.tracks) {
      if (ids.has(t.id)) throw new Error(`Catálogo de áudio: id repetido "${t.id}"`);
      ids.add(t.id);
      const path = this.path(t);
      const info = await stat(path).catch(() => undefined);
      if (!info?.isFile()) throw new Error(`Catálogo de áudio: arquivo de "${t.id}" não encontrado (${t.file})`);
    }
    this.tracks = raw.tracks;
  }

  private path(t: Track): string {
    const root = resolve(this.dir);
    const p = resolve(root, t.file);
    if (!p.startsWith(root + sep)) throw new Error(`Catálogo de áudio: caminho inválido em "${t.id}"`);
    return p;
  }

  moods(): string[] {
    return [...new Set(this.tracks.flatMap((t) => t.moods))].sort();
  }

  async list() {
    const out = [];
    for (const t of this.tracks) {
      let duration = this.durations.get(t.id);
      if (duration === undefined) {
        duration = await probe(this.path(t))
          .then((m) => m.duration)
          .catch(() => 0);
        this.durations.set(t.id, duration);
      }
      out.push({
        id: t.id,
        name: t.name,
        moods: t.moods,
        duration: Math.round(duration * 100) / 100,
        license: t.license,
        attribution: t.attribution ?? null,
        source: t.source ?? null,
      });
    }
    return { tracks: out, moods: this.moods() };
  }

  /**
   * Escolhe a faixa por id, ou sorteia entre as do clima pedido.
   * Sem semente, uma é gerada e devolvida, para o sorteio poder ser repetido.
   */
  pick(by: { libraryId?: string; mood?: string; seed?: number }): { track: Track; file: string; seed?: number } {
    if (by.libraryId !== undefined) {
      const track = this.tracks.find((t) => t.id === by.libraryId);
      if (!track) {
        throw new ApiError(422, "audio_not_found", `Música "${by.libraryId}" não existe na biblioteca`, {
          available: this.tracks.map((t) => t.id),
        });
      }
      return { track, file: this.path(track) };
    }
    const mood = by.mood!;
    const candidates = this.tracks.filter((t) => t.moods.includes(mood));
    if (candidates.length === 0) {
      throw new ApiError(
        422,
        "no_tracks_for_mood",
        this.tracks.length === 0
          ? "A biblioteca de áudio ainda está vazia. Envie o arquivo de áudio no pedido."
          : `Nenhuma música com o clima "${mood}"`,
        { moods: this.moods() },
      );
    }
    const seed = by.seed ?? randomInt(0, 2 ** 32 - 1);
    const track = candidates[Math.floor(seeded(seed)() * candidates.length)]!;
    return { track, file: this.path(track), seed };
  }
}
