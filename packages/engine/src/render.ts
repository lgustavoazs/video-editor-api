import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import sharp from "sharp";
import { EngineError } from "./errors.js";
import { parseBench, probe, runFfmpeg, type BenchStats } from "./ffmpeg.js";
import { buildFiltergraph } from "./filtergraph.js";
import type { PlatformProfile } from "./platforms.js";
import type { Preset } from "./preset.js";
import { computeTiming, resolveAudioSegment, type AudioSegmentInput, type TimingResult } from "./timing.js";

export const MAX_PHOTOS = 30;

export interface RenderRequest {
  photos: string[];
  preset: Preset;
  platform: PlatformProfile;
  output: string;
  timing: { mode: "audio" | "fixed"; total?: number };
  audio?: { file: string } & AudioSegmentInput;
  /** Ajustes de encode, usados nas medições da Fase 0. */
  encode?: { x264Preset?: string; crf?: number; supersample?: number };
}

export interface RenderResult {
  output: string;
  duration: number;
  width: number;
  height: number;
  fps: number;
  photoCount: number;
  audioSegment?: { start: number; end: number };
  timing: TimingResult;
  warnings: string[];
  stats: {
    prepareSeconds: number;
    renderSeconds: number;
    totalSeconds: number;
    /** Segundos de render por segundo de vídeo (menor é melhor). */
    renderRatio: number;
    outputBytes: number;
    ffmpeg: BenchStats;
  };
}

/**
 * Corrige a rotação (EXIF), converte para sRGB e redimensiona para cobrir o quadro
 * com folga (supersample), o que evita tremor no zoom do Ken Burns.
 */
async function normalizePhoto(input: string, output: string, width: number, height: number): Promise<void> {
  try {
    await sharp(input, { failOn: "error", limitInputPixels: 8000 * 8000 })
      .rotate()
      .resize(width, height, { fit: "cover", position: "centre" })
      .toColourspace("srgb")
      .jpeg({ quality: 92, chromaSubsampling: "4:4:4" })
      .toFile(output);
  } catch (err) {
    throw new EngineError("unreadable_photo", `Não foi possível ler a foto: ${input}`, {
      cause: (err as Error).message,
    });
  }
}

export async function renderVideo(req: RenderRequest): Promise<RenderResult> {
  const started = process.hrtime.bigint();
  const { preset, platform } = req;
  const count = req.photos.length;
  if (count < 1) throw new EngineError("no_photos", "Informe ao menos uma foto");
  if (count > MAX_PHOTOS) {
    throw new EngineError("too_many_photos", `Máximo de ${MAX_PHOTOS} fotos por vídeo`, {
      photoCount: count,
      maxPhotos: MAX_PHOTOS,
    });
  }

  // 1. Áudio: sonda a faixa e resolve o trecho antes de qualquer trabalho pesado.
  let segment;
  if (req.audio) {
    const info = await probe(req.audio.file);
    if (!info.hasAudio) {
      throw new EngineError("unreadable_media", "O arquivo informado não contém áudio");
    }
    segment = resolveAudioSegment(req.audio, info.duration);
  }

  // 2. Duração proporcional.
  const timing = computeTiming({
    photoCount: count,
    fps: platform.fps,
    transition: preset.transition.duration,
    perPhotoMin: preset.timing.perPhotoMin,
    perPhotoMax: preset.timing.perPhotoMax,
    maxDuration: platform.maxDuration,
    mode: req.timing.mode,
    requestedTotal: req.timing.total,
    segment,
  });

  if (segment && timing.total > segment.length + 1 / platform.fps && segment.loop) {
    throw new EngineError("not_implemented", "Repetição (loop) do trecho de áudio entra na Fase 1A");
  }

  const supersample = req.encode?.supersample ?? 2;
  const workDir = await mkdtemp(join(tmpdir(), "render-"));
  try {
    // 3. Normaliza as fotos.
    const normalized = req.photos.map((_, i) => join(workDir, `photo-${String(i).padStart(3, "0")}.jpg`));
    for (const [i, photo] of req.photos.entries()) {
      await normalizePhoto(
        photo,
        normalized[i]!,
        Math.round(platform.width * supersample),
        Math.round(platform.height * supersample),
      );
    }
    const prepared = process.hrtime.bigint();

    // 4. Monta o comando do FFmpeg.
    const audioLength = segment ? Math.min(segment.length, timing.total) : 0;
    const graph = buildFiltergraph({
      preset,
      platform,
      timing,
      photoCount: count,
      audio: segment ? { inputIndex: count, start: segment.start, length: audioLength } : undefined,
    });

    const args: string[] = ["-hide_banner", "-y", "-benchmark"];
    for (const file of normalized) args.push("-i", file);
    if (req.audio) args.push("-i", req.audio.file);
    args.push("-filter_complex", graph.graph, "-map", `[${graph.videoLabel}]`);
    if (graph.audioLabel) {
      args.push("-map", `[${graph.audioLabel}]`, "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2");
    }
    args.push(
      "-c:v", "libx264",
      "-preset", req.encode?.x264Preset ?? "medium",
      "-crf", String(req.encode?.crf ?? 20),
      "-profile:v", "high",
      "-pix_fmt", "yuv420p",
      "-r", String(platform.fps),
      "-frames:v", String(timing.totalFrames),
      "-t", timing.total.toFixed(6),
      "-movflags", "+faststart",
      req.output,
    );

    await mkdir(dirname(req.output), { recursive: true });
    const res = await runFfmpeg(args);
    if (res.code !== 0) {
      throw new EngineError("render_failed", "O FFmpeg falhou ao renderizar o vídeo", {
        exitCode: res.code,
        stderr: res.stderr.slice(-2000),
      });
    }
    const finished = process.hrtime.bigint();

    const out = await probe(req.output);
    const { size } = await stat(req.output);
    const prepareSeconds = Number(prepared - started) / 1e9;
    const renderSeconds = Number(finished - prepared) / 1e9;

    return {
      output: req.output,
      duration: out.duration,
      width: out.width ?? platform.width,
      height: out.height ?? platform.height,
      fps: platform.fps,
      photoCount: count,
      audioSegment: segment ? { start: segment.start, end: segment.start + audioLength } : undefined,
      timing,
      warnings: timing.warnings,
      stats: {
        prepareSeconds: round(prepareSeconds),
        renderSeconds: round(renderSeconds),
        totalSeconds: round(prepareSeconds + renderSeconds),
        renderRatio: round((prepareSeconds + renderSeconds) / out.duration),
        outputBytes: size,
        ffmpeg: parseBench(res.stderr),
      },
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
