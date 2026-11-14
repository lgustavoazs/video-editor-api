import { EngineError } from "./errors.js";
import { runFfmpeg } from "./ffmpeg.js";

/** Todas as transições do filtro xfade do FFmpeg 6.1+ (exceto "custom"). */
export const ALL_TRANSITIONS = [
  "fade", "fadefast", "fadeslow", "fadeblack", "fadewhite", "fadegrays", "dissolve", "distance",
  "wipeleft", "wiperight", "wipeup", "wipedown", "wipetl", "wipetr", "wipebl", "wipebr",
  "slideleft", "slideright", "slideup", "slidedown",
  "smoothleft", "smoothright", "smoothup", "smoothdown",
  "coverleft", "coverright", "coverup", "coverdown",
  "revealleft", "revealright", "revealup", "revealdown",
  "circleopen", "circleclose", "circlecrop", "rectcrop",
  "vertopen", "vertclose", "horzopen", "horzclose",
  "diagtl", "diagtr", "diagbl", "diagbr",
  "hlslice", "hrslice", "vuslice", "vdslice",
  "hlwind", "hrwind", "vuwind", "vdwind",
  "squeezeh", "squeezev", "radial", "zoomin", "pixelize", "hblur",
] as const;

export type TransitionName = (typeof ALL_TRANSITIONS)[number];

export interface TransitionConfig {
  types: TransitionName[];
  order: "cycle" | "random";
  seed: number;
  duration: number;
}

/** Gerador pseudoaleatório determinístico (mulberry32): mesma semente, mesma sequência. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Escolhe a transição de cada uma das `count` passagens.
 * - cycle: percorre a lista em rodízio.
 * - random: sorteia com semente fixa, sem repetir a mesma duas vezes seguidas
 *   (quando a lista tem mais de uma).
 */
export function pickTransitions(config: TransitionConfig, count: number): TransitionName[] {
  const { types } = config;
  if (types.length === 0) throw new EngineError("invalid_preset", "A lista de transições está vazia");
  const out: TransitionName[] = [];
  if (config.order === "cycle" || types.length === 1) {
    for (let i = 0; i < count; i++) out.push(types[i % types.length]!);
    return out;
  }
  const random = mulberry32(config.seed);
  let previous: TransitionName | undefined;
  for (let i = 0; i < count; i++) {
    let pick = types[Math.floor(random() * types.length)]!;
    if (pick === previous) pick = types[(types.indexOf(pick) + 1) % types.length]!;
    out.push(pick);
    previous = pick;
  }
  return out;
}

let supportedCache: Promise<Set<string>> | undefined;

/** Transições que o FFmpeg instalado realmente oferece (versões antigas têm menos). */
export function supportedTransitions(): Promise<Set<string>> {
  supportedCache ??= (async () => {
    const res = await runFfmpeg(["-hide_banner", "-h", "filter=xfade"]);
    const found = new Set<string>();
    for (const line of res.stdout.split("\n")) {
      const m = /^\s+([a-z]+)\s+-?\d+\s+\.\.FV/.exec(line);
      if (m && m[1] !== "custom") found.add(m[1]!);
    }
    if (found.size === 0) {
      throw new EngineError("ffmpeg_unsupported", "O FFmpeg instalado não tem o filtro xfade");
    }
    return found;
  })();
  return supportedCache;
}

export async function assertTransitionsSupported(names: readonly string[]): Promise<void> {
  const supported = await supportedTransitions();
  const missing = [...new Set(names)].filter((n) => !supported.has(n));
  if (missing.length > 0) {
    throw new EngineError(
      "transition_unsupported",
      `O FFmpeg instalado não oferece estas transições: ${missing.join(", ")}. Atualize o FFmpeg para 6.1 ou superior.`,
      { missing },
    );
  }
}
