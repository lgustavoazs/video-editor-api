import { access, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { EngineError } from "./errors.js";
import { parseBench, probe, runFfmpeg, summarizeFfmpegError, type BenchStats } from "./ffmpeg.js";
import { buildFiltergraph, panDirection, zoomRange, type Segment } from "./filtergraph.js";
import type { PlatformProfile } from "./platforms.js";
import { prepareCard, preparePhoto, prepareWatermark, type Focus } from "./prepare.js";
import type { CardConfig, LogoRole, Preset } from "./preset.js";
import {
  charsPerLine,
  cleanText,
  MAX_CAPTION_LENGTH,
  MAX_TITLE_LENGTH,
  wrapText,
  type TextLayout,
} from "./text.js";
import { computeTiming, resolveAudioSegment, type AudioSegmentInput, type TimingResult } from "./timing.js";
import { assertTransitionsSupported, pickTransitions } from "./transitions.js";

export const MAX_ITEMS = 30;

export interface RenderItem {
  /** "clip" (vídeo) entra na Fase 1C. */
  type: "photo" | "clip";
  file: string;
  /** Ponto de interesse da foto (0 a 1 em cada eixo). */
  focus?: Focus;
  /** Legenda exibida sobre o item, se o preset tiver estilo de legenda. */
  caption?: string;
}

export interface RenderRequest {
  items: RenderItem[];
  preset: Preset;
  platform: PlatformProfile;
  output: string;
  timing: { mode: "audio" | "fixed"; total?: number };
  audio?: { file: string } & AudioSegmentInput;
  logos?: { role: LogoRole; file: string }[];
  title?: string;
  /** Pastas de recursos do motor. */
  assets: { lutsDir: string; fontsDir: string };
  /** Ajustes de encode, usados em medições. */
  encode?: { x264Preset?: string; crf?: number; supersample?: number };
}

export interface RenderResult {
  output: string;
  duration: number;
  width: number;
  height: number;
  fps: number;
  itemCount: number;
  /** Enquadramento efetivo de cada item, na ordem recebida. */
  fits: ("cover" | "contain")[];
  /** Transição usada em cada passagem da linha do tempo. */
  transitions: string[];
  audioSegment?: { start: number; end: number; looped: boolean };
  timing: TimingResult;
  warnings: string[];
  stats: {
    prepareSeconds: number;
    renderSeconds: number;
    totalSeconds: number;
    /** Segundos de processamento por segundo de vídeo (menor é melhor). */
    renderRatio: number;
    outputBytes: number;
    ffmpeg: BenchStats;
  };
}

function validateRequest(req: RenderRequest): void {
  const count = req.items.length;
  if (count < 1) throw new EngineError("no_photos", "Informe ao menos um item");
  if (count > MAX_ITEMS) {
    throw new EngineError("too_many_photos", `Máximo de ${MAX_ITEMS} itens por vídeo`, {
      photoCount: count,
      maxPhotos: MAX_ITEMS,
    });
  }
  req.items.forEach((item, i) => {
    if (item.type === "clip") {
      throw new EngineError("not_implemented", "Clipes de vídeo entram na Fase 1C", { item: i });
    }
    if (item.type !== "photo") {
      throw new EngineError("invalid_item", `items[${i}].type deve ser "photo"`, { item: i });
    }
    if (item.focus) {
      const { x, y } = item.focus;
      if (![x, y].every((v) => typeof v === "number" && v >= 0 && v <= 1)) {
        throw new EngineError("invalid_item", `items[${i}].focus: x e y devem estar entre 0 e 1`, { item: i });
      }
    }
    if (item.caption !== undefined && cleanText(item.caption).length > MAX_CAPTION_LENGTH) {
      throw new EngineError("text_too_long", `items[${i}].caption: máximo de ${MAX_CAPTION_LENGTH} caracteres`, {
        item: i,
      });
    }
  });
  if (req.title !== undefined && cleanText(req.title).length > MAX_TITLE_LENGTH) {
    throw new EngineError("text_too_long", `title: máximo de ${MAX_TITLE_LENGTH} caracteres`);
  }
  const roles = (req.logos ?? []).map((l) => l.role);
  if (roles.length > 2 || new Set(roles).size !== roles.length) {
    throw new EngineError("invalid_logos", "Envie no máximo uma logo por papel (brand e partner)");
  }
}

interface PlannedCard {
  slot: "intro" | "between" | "outro";
  config: CardConfig;
  logoFile: string;
}

/** Define quais cartões de logo entram, conforme o preset e as logos recebidas. */
function planCards(
  preset: Preset,
  logos: Map<LogoRole, string>,
  itemCount: number,
  warnings: string[],
): { intro?: PlannedCard; between?: PlannedCard & { every: number; count: number }; outro?: PlannedCard } {
  const b = preset.branding;
  if (!b) return {};
  const plan = (slot: PlannedCard["slot"], config: CardConfig | null): PlannedCard | undefined => {
    if (!config) return undefined;
    const logoFile = logos.get(config.role);
    if (!logoFile) {
      warnings.push(`O preset usa a logo "${config.role}" no cartão "${slot}", mas ela não foi enviada; o cartão foi ignorado.`);
      return undefined;
    }
    return { slot, config, logoFile };
  };
  const between = plan("between", b.between);
  const every = b.between?.every ?? 3;
  const count = between ? Math.floor((itemCount - 1) / every) : 0;
  return {
    intro: plan("intro", b.intro),
    between: between && count > 0 ? { ...between, every, count } : undefined,
    outro: plan("outro", b.outro),
  };
}

export async function renderVideo(req: RenderRequest): Promise<RenderResult> {
  const started = process.hrtime.bigint();
  const { preset, platform } = req;
  const { width: W, height: H, fps } = platform;
  validateRequest(req);
  const count = req.items.length;
  const warnings: string[] = [];

  await assertTransitionsSupported(preset.transition.types);
  for (const f of preset.photo.filters) {
    if (f.type === "lut") {
      await access(join(req.assets.lutsDir, f.file)).catch(() => {
        throw new EngineError("lut_not_found", `LUT não encontrado: ${f.file}`, { file: f.file });
      });
    }
  }

  // 1. Áudio: sonda a faixa e resolve o trecho antes de qualquer trabalho pesado.
  let segment;
  if (req.audio) {
    const info = await probe(req.audio.file);
    if (!info.hasAudio) throw new EngineError("unreadable_media", "O arquivo informado não contém áudio");
    segment = resolveAudioSegment(req.audio, info.duration);
  }

  // 2. Cartões de logo e duração proporcional.
  const logos = new Map((req.logos ?? []).map((l) => [l.role, l.file]));
  const cards = planCards(preset, logos, count, warnings);
  const cardDurations = [
    ...(cards.intro ? [cards.intro.config.duration] : []),
    ...Array.from({ length: cards.between?.count ?? 0 }, () => cards.between!.config.duration),
    ...(cards.outro ? [cards.outro.config.duration] : []),
  ];
  const timing = computeTiming({
    photoCount: count,
    fps,
    transition: preset.transition.duration,
    perPhotoMin: preset.timing.perPhotoMin,
    perPhotoMax: preset.timing.perPhotoMax,
    maxDuration: platform.maxDuration,
    mode: req.timing.mode,
    requestedTotal: req.timing.total,
    segment,
    cards: cardDurations,
  });
  warnings.push(...timing.warnings);
  const cardFrames = [...timing.cardFrames];

  // Margens para texto e marca d'água: zona segura da plataforma ou barra de cinema, a que for maior.
  const bar = Math.round(preset.letterbox * H);
  const safeTop = Math.max(platform.safeZone.top * H, bar);
  const safeBottom = Math.max(platform.safeZone.bottom * H, bar);
  const layout: TextLayout = {
    frameWidth: W,
    frameHeight: H,
    marginTop: safeTop + 0.02 * H,
    marginBottom: safeBottom + 0.02 * H,
    marginSide: Math.max(platform.safeZone.left, platform.safeZone.right) * W + 0.03 * W,
  };

  const supersample = req.encode?.supersample ?? 2;
  const workDir = await mkdtemp(join(tmpdir(), "render-"));
  try {
    const inputs: string[] = [];
    const segments: Segment[] = [];
    /** true quando a passagem ANTES do segmento i toca um cartão (usa sempre fade). */
    const touchesCard: boolean[] = [];
    const fits: ("cover" | "contain")[] = [];
    let textCount = 0;
    const writeText = async (lines: string[]): Promise<string> => {
      const file = join(workDir, `texto-${textCount++}.txt`);
      await writeFile(file, lines.join("\n"), "utf8");
      return file;
    };

    const addCard = async (card: PlannedCard): Promise<void> => {
      const file = join(workDir, `cartao-${inputs.length}.jpg`);
      const caption = card.config.caption ? cleanText(card.config.caption) : "";
      const { captionY } = await prepareCard(
        card.logoFile, file, W, H, card.config.background, card.config.width, caption.length > 0,
      );
      inputs.push(file);
      segments.push({
        kind: "card",
        frames: cardFrames.shift()!,
        caption: caption
          ? {
              textFile: await writeText(wrapText(caption, charsPerLine({ size: 0.03 }, layout))),
              y: captionY,
              color: card.config.captionColor,
            }
          : undefined,
      });
    };

    // 3. Monta a linha do tempo: abertura, itens (com cartões intercalados) e encerramento.
    if (cards.intro) await addCard(cards.intro);
    for (const [i, item] of req.items.entries()) {
      const file = join(workDir, `foto-${String(i).padStart(3, "0")}.jpg`);
      const prepared = await preparePhoto(
        item.file, file, Math.round(W * supersample), Math.round(H * supersample), preset.photo, item.focus,
      );
      fits.push(prepared.fit);
      const zoom = zoomRange(preset.motion, i);
      const caption = item.caption ? cleanText(item.caption) : "";
      let captionFile: string | undefined;
      if (caption) {
        if (preset.text?.caption) {
          captionFile = await writeText(wrapText(caption, charsPerLine(preset.text.caption, layout)));
        } else if (!warnings.some((w) => w.startsWith("Legendas"))) {
          warnings.push("Legendas foram enviadas, mas o preset não define estilo de legenda; elas foram ignoradas.");
        }
      }
      inputs.push(file);
      segments.push({
        kind: "photo",
        frames: timing.photoFrames[i]!,
        zoomFrom: zoom.from,
        zoomTo: zoom.to,
        pan: panDirection(preset.motion, i),
        focus: prepared.focus,
        captionFile,
      });
      const isLast = i === count - 1;
      if (cards.between && !isLast && (i + 1) % cards.between.every === 0) await addCard(cards.between);
    }
    if (cards.outro) await addCard(cards.outro);

    // Transições: as que tocam um cartão são sempre fade; as demais seguem o preset.
    segments.forEach((s, i) => {
      if (i > 0) touchesCard.push(s.kind === "card" || segments[i - 1]!.kind === "card");
    });
    const picked = pickTransitions(preset.transition, touchesCard.filter((c) => !c).length);
    const transitions = touchesCard.map((card) => (card ? "fade" : picked.shift()!));

    // 4. Título e marca d'água.
    let title: { textFile: string } | undefined;
    const titleText = req.title ? cleanText(req.title) : "";
    if (titleText) {
      if (preset.text?.title) {
        title = { textFile: await writeText(wrapText(titleText, charsPerLine(preset.text.title, layout))) };
      } else {
        warnings.push("Um título foi enviado, mas o preset não define estilo de título; ele foi ignorado.");
      }
    }

    let watermark;
    let titleLayout: TextLayout | undefined;
    const wm = preset.branding?.watermark;
    if (wm) {
      const logoFile = logos.get(wm.role);
      if (!logoFile) {
        warnings.push(`O preset usa a logo "${wm.role}" como marca d'água, mas ela não foi enviada.`);
      } else {
        const file = join(workDir, "marca.png");
        const size = await prepareWatermark(logoFile, file, Math.round(wm.width * W), Math.round(0.25 * H));
        const marginX = wm.margin * W;
        const marginY = wm.margin * W;
        const [vertical, horizontal] = wm.position.split("-") as ["top" | "bottom", "left" | "center" | "right"];
        const x =
          horizontal === "left"
            ? platform.safeZone.left * W + marginX
            : horizontal === "right"
              ? W - size.width - platform.safeZone.right * W - marginX
              : (W - size.width) / 2;
        const y = vertical === "top" ? safeTop + marginY : H - size.height - safeBottom - marginY;
        // A marca d'água aparece só sobre os itens. Cada janela vai do meio da transição
        // de entrada ao meio da transição de saída de uma sequência de itens.
        const tf = timing.transitionFrames;
        const windows: { from: number; to: number }[] = [];
        let startFrame = 0;
        segments.forEach((s, i) => {
          const endFrame = startFrame + s.frames;
          if (s.kind === "photo") {
            const from = (i === 0 ? 0 : startFrame + tf / 2) / fps;
            const to = (i === segments.length - 1 ? timing.totalFrames : endFrame - tf / 2) / fps;
            const last = windows.at(-1);
            if (last && segments[i - 1]!.kind === "photo") last.to = to;
            else windows.push({ from, to });
          }
          startFrame = endFrame - tf;
        });
        watermark = { inputIndex: inputs.length, x, y, opacity: wm.opacity, windows };
        // Título e marca d'água na mesma faixa: o título passa para depois da logo.
        const titleStyle = preset.text?.title;
        if (title && titleStyle && titleStyle.position !== "center") {
          const gap = 0.015 * H;
          if (titleStyle.position === "top" && vertical === "top") {
            titleLayout = { ...layout, marginTop: y + size.height + gap };
          } else if (titleStyle.position === "bottom" && vertical === "bottom") {
            titleLayout = { ...layout, marginBottom: H - y + gap };
          }
        }
        inputs.push(file);
      }
    }
    const prepared = process.hrtime.bigint();

    // 5. Monta o comando do FFmpeg.
    const graph = buildFiltergraph({
      preset,
      platform,
      segments,
      transitions,
      transitionFrames: timing.transitionFrames,
      total: timing.total,
      filterContext: { lutsDir: req.assets.lutsDir },
      fontsDir: req.assets.fontsDir,
      layout,
      title,
      titleLayout,
      watermark,
      audio: segment
        ? { inputIndex: inputs.length, start: segment.start, segmentLength: segment.length, loop: segment.loop }
        : undefined,
    });

    const args: string[] = ["-hide_banner", "-y", "-benchmark"];
    for (const file of inputs) args.push("-i", file);
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
      "-r", String(fps),
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
        stderr: summarizeFfmpegError(res.stderr),
      });
    }
    const finished = process.hrtime.bigint();

    const out = await probe(req.output);
    const { size } = await stat(req.output);
    const prepareSeconds = Number(prepared - started) / 1e9;
    const renderSeconds = Number(finished - prepared) / 1e9;
    const looped = Boolean(segment && segment.loop && segment.length < timing.total - 1e-6);

    return {
      output: req.output,
      duration: out.duration,
      width: out.width ?? W,
      height: out.height ?? H,
      fps,
      itemCount: count,
      fits,
      transitions,
      audioSegment: segment
        ? { start: segment.start, end: segment.start + Math.min(segment.length, timing.total), looped }
        : undefined,
      timing,
      warnings,
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
