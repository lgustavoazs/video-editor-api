import { access, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { EngineError } from "./errors.js";
import { displaySize, isHdr, MAX_CLIP_SIDE, MAX_CLIPS, resolveClipRange, type ClipRangeInput } from "./clip.js";
import {
  availableFilters,
  parseBench,
  probe,
  probeClip,
  runFfmpeg,
  summarizeFfmpegError,
  type BenchStats,
  type ClipInfo,
} from "./ffmpeg.js";
import { buildFiltergraph, panDirection, zoomRange, type Segment } from "./filtergraph.js";
import type { PlatformProfile } from "./platforms.js";
import { coverLoss, prepareCard, preparePhoto, prepareWatermark, resolveFit, type Focus } from "./prepare.js";
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
/** Aproximação máxima do enquadramento de um item. */
export const MAX_ITEM_ZOOM = 4;

export interface RenderItem extends ClipRangeInput {
  type: "photo" | "clip";
  file: string;
  /** Ponto de interesse (0 a 1 em cada eixo), usado no corte. */
  focus?: Focus;
  /**
   * Aproximação do enquadramento, de 1 (sem zoom) a 4: mostra uma área menor da foto ou do
   * clipe, centrada no ponto de interesse. Acima de 1 força o corte, mesmo em estilos que
   * mostram a foto inteira.
   */
  zoom?: number;
  /** Legenda exibida sobre o item, se o preset tiver estilo de legenda. */
  caption?: string;
  /** Só clipes: mistura o som original do clipe à música. Padrão: false (mudo). */
  keepAudio?: boolean;
  /** Só clipes: volume do som original, de 0 a 2. Padrão: 1. */
  volume?: number;
}

/** O que o planejamento precisa: tudo do pedido, menos a saída e os ajustes de encode. */
export interface PlanRequest {
  items: RenderItem[];
  preset: Preset;
  platform: PlatformProfile;
  timing: { mode: "audio" | "fixed"; total?: number };
  audio?: { file: string } & AudioSegmentInput;
  logos?: { role: LogoRole; file: string }[];
  title?: string;
  /** Pastas de recursos do motor. */
  assets: { lutsDir: string; fontsDir: string };
}

export interface RenderRequest extends PlanRequest {
  output: string;
  /** Ajustes de encode, usados em medições. */
  /** `threads` limita as threads de filtros e do codificador (padrão: `defaultThreads()`). */
  encode?: { x264Preset?: string; crf?: number; supersample?: number; threads?: number };
  /** Recebe o progresso de 0 a 1 durante o render. */
  onProgress?: (fraction: number) => void;
  /** Plano já calculado por `planRender` (evita sondar os arquivos de novo). */
  plan?: RenderPlan;
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
  /** Detalhes de cada clipe usado, na ordem em que aparecem. */
  clips: { item: number; start: number; end: number; hdr: boolean; keptAudio: boolean }[];
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

function validateRequest(req: PlanRequest): void {
  const count = req.items.length;
  if (count < 1) throw new EngineError("no_photos", "Informe ao menos um item");
  if (count > MAX_ITEMS) {
    throw new EngineError("too_many_photos", `Máximo de ${MAX_ITEMS} itens por vídeo`, {
      photoCount: count,
      maxPhotos: MAX_ITEMS,
    });
  }
  let clips = 0;
  req.items.forEach((item, i) => {
    if (item.type !== "photo" && item.type !== "clip") {
      throw new EngineError("invalid_item", `items[${i}].type deve ser "photo" ou "clip"`, { item: i });
    }
    if (item.type === "clip") {
      clips++;
      if (item.keepAudio !== undefined && typeof item.keepAudio !== "boolean") {
        throw new EngineError("invalid_clip", `items[${i}].keepAudio deve ser true ou false`, { item: i });
      }
      if (item.volume !== undefined && !(typeof item.volume === "number" && item.volume >= 0 && item.volume <= 2)) {
        throw new EngineError("invalid_clip", `items[${i}].volume deve estar entre 0 e 2`, { item: i });
      }
    } else if ([item.start, item.end, item.duration, item.keepAudio, item.volume].some((v) => v !== undefined)) {
      throw new EngineError("invalid_item", `items[${i}]: start, end, duration, keepAudio e volume valem só para clipes`, {
        item: i,
      });
    }
    if (item.focus) {
      const { x, y } = item.focus;
      if (![x, y].every((v) => typeof v === "number" && v >= 0 && v <= 1)) {
        throw new EngineError("invalid_item", `items[${i}].focus: x e y devem estar entre 0 e 1`, { item: i });
      }
    }
    if (item.zoom !== undefined && !(typeof item.zoom === "number" && item.zoom >= 1 && item.zoom <= MAX_ITEM_ZOOM)) {
      throw new EngineError("invalid_item", `items[${i}].zoom: deve estar entre 1 e ${MAX_ITEM_ZOOM}`, { item: i });
    }
    if (item.caption !== undefined && cleanText(item.caption).length > MAX_CAPTION_LENGTH) {
      throw new EngineError("text_too_long", `items[${i}].caption: máximo de ${MAX_CAPTION_LENGTH} caracteres`, {
        item: i,
      });
    }
  });
  if (clips > MAX_CLIPS) {
    throw new EngineError("too_many_clips", `Máximo de ${MAX_CLIPS} clipes por vídeo`, { clipCount: clips, maxClips: MAX_CLIPS });
  }
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

/**
 * Threads usadas quando a requisição não informa: a variável FFMPEG_THREADS ou, na falta dela,
 * a quantidade de CPUs que o processo pode de fato usar (respeita a cota do container), até 8.
 */
export function defaultThreads(): number {
  const fromEnv = Number(process.env.FFMPEG_THREADS);
  if (Number.isInteger(fromEnv) && fromEnv >= 1 && fromEnv <= 64) return fromEnv;
  return Math.max(1, Math.min(8, availableParallelism()));
}

interface PlannedClip {
  item: number;
  info: ClipInfo;
  start: number;
  length: number;
  fit: "cover" | "contain";
  focus: Focus;
  zoom: number;
  hdr: boolean;
  audio?: { volume: number };
}

/**
 * Resultado do planejamento: tudo o que se decide sem processar imagem nem vídeo.
 * Os campos internos são usados pelo render; o resumo público está em `duration`,
 * `itemCount` e `warnings`.
 */
export interface RenderPlan {
  duration: number;
  itemCount: number;
  warnings: string[];
  /** @internal */
  internal: {
    segment?: ReturnType<typeof resolveAudioSegment>;
    clipPlans: Map<number, PlannedClip>;
    logos: Map<LogoRole, string>;
    cards: ReturnType<typeof planCards>;
    timing: TimingResult;
    layout: TextLayout;
    safeTop: number;
    safeBottom: number;
  };
}

/**
 * Valida o pedido, sonda áudio e clipes e calcula a linha do tempo, sem renderizar.
 * Leva menos de um segundo; serve para a API recusar um pedido antes de enfileirá-lo.
 */
export async function planRender(req: PlanRequest): Promise<RenderPlan> {
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

  // 1b. Clipes: sonda cada arquivo, resolve o trecho e decide enquadramento e conversão de cor.
  const filters = await availableFilters();
  const canToneMap = filters.has("zscale") && filters.has("tonemap");
  const clipPlans = new Map<number, PlannedClip>();
  for (const [i, item] of req.items.entries()) {
    if (item.type !== "clip") continue;
    const info = await probeClip(item.file);
    if (Math.max(info.width, info.height) > MAX_CLIP_SIDE) {
      throw new EngineError("clip_too_large", `items[${i}]: resolução máxima de ${MAX_CLIP_SIDE} px no lado maior (4K)`, {
        item: i, width: info.width, height: info.height,
      });
    }
    const range = resolveClipRange(item, info.duration, i);
    const size = displaySize(info);
    const zoom = item.zoom ?? 1;
    const fit = zoom > 1 ? "cover" : resolveFit(preset.photo, coverLoss(size.width, size.height, W, H), item.focus !== undefined);
    let hdr = isHdr(info);
    if (hdr && !canToneMap) {
      warnings.push(`O clipe ${i + 1} é HDR, mas o FFmpeg instalado não converte HDR; as cores podem sair lavadas.`);
      hdr = false;
    }
    let audio: PlannedClip["audio"];
    if (item.keepAudio) {
      if (info.hasAudio) audio = { volume: item.volume ?? 1 };
      else warnings.push(`O clipe ${i + 1} não tem som; o pedido para manter o som original foi ignorado.`);
    }
    clipPlans.set(i, {
      item: i, info, ...range, fit, hdr, audio, zoom,
      focus: fit === "cover" ? (item.focus ?? { x: 0.5, y: 0.5 }) : { x: 0.5, y: 0.5 },
    });
  }
  const photoCount = count - clipPlans.size;

  // 2. Cartões de logo e duração proporcional.
  const logos = new Map((req.logos ?? []).map((l) => [l.role, l.file]));
  const cards = planCards(preset, logos, count, warnings);
  const cardDurations = [
    ...(cards.intro ? [cards.intro.config.duration] : []),
    ...Array.from({ length: cards.between?.count ?? 0 }, () => cards.between!.config.duration),
    ...(cards.outro ? [cards.outro.config.duration] : []),
  ];
  const timing = computeTiming({
    photoCount,
    fps,
    transition: preset.transition.duration,
    perPhotoMin: preset.timing.perPhotoMin,
    perPhotoMax: preset.timing.perPhotoMax,
    maxDuration: platform.maxDuration,
    mode: req.timing.mode,
    requestedTotal: req.timing.total,
    segment,
    cards: cardDurations,
    clips: [...clipPlans.values()].map((c) => c.length),
  });
  warnings.push(...timing.warnings);

  // Avisos que dependem só do pedido e do preset (repetidos no render, onde os textos são gerados).
  if (req.items.some((item) => item.caption && cleanText(item.caption)) && !preset.text?.caption) {
    warnings.push("Legendas foram enviadas, mas o preset não define estilo de legenda; elas foram ignoradas.");
  }
  if (req.title && cleanText(req.title) && !preset.text?.title) {
    warnings.push("Um título foi enviado, mas o preset não define estilo de título; ele foi ignorado.");
  }
  const wm = preset.branding?.watermark;
  if (wm && !logos.get(wm.role)) {
    warnings.push(`O preset usa a logo "${wm.role}" como marca d'água, mas ela não foi enviada.`);
  }

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

  return {
    duration: timing.total,
    itemCount: count,
    warnings,
    internal: { segment, clipPlans, logos, cards, timing, layout, safeTop, safeBottom },
  };
}

export async function renderVideo(req: RenderRequest): Promise<RenderResult> {
  const started = process.hrtime.bigint();
  const { preset, platform } = req;
  const { width: W, height: H, fps } = platform;
  const plan = req.plan ?? (await planRender(req));
  const count = plan.itemCount;
  const warnings = [...plan.warnings];
  const { segment, clipPlans, logos, cards, timing, layout, safeTop, safeBottom } = plan.internal;
  const cardFrames = [...timing.cardFrames];
  const progress = (fraction: number) => req.onProgress?.(Math.max(0, Math.min(1, fraction)));
  progress(0);

  const supersample = req.encode?.supersample ?? 2;
  const workDir = await mkdtemp(join(tmpdir(), "render-"));
  try {
    const inputs: string[] = [];
    /** Opções de entrada de cada input (clipes: posição e duração do trecho). */
    const inputOptions = new Map<number, string[]>();
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
    let photoIndex = 0;
    let clipIndex = 0;
    for (const [i, item] of req.items.entries()) {
      const caption = item.caption ? cleanText(item.caption) : "";
      let captionFile: string | undefined;
      if (caption) {
        if (preset.text?.caption) {
          captionFile = await writeText(wrapText(caption, charsPerLine(preset.text.caption, layout)));
        }
      }

      const clip = clipPlans.get(i);
      if (clip) {
        fits.push(clip.fit);
        // margem de meio segundo: o filtergraph corta na contagem exata de quadros
        inputOptions.set(inputs.length, [
          "-threads", "2",
          "-ss", clip.start.toFixed(6),
          "-t", Math.min(clip.length + 0.5, clip.info.duration - clip.start + 0.5).toFixed(6),
        ]);
        inputs.push(item.file);
        segments.push({
          kind: "clip",
          frames: timing.clipFrames[clipIndex++]!,
          video: { fit: clip.fit, focus: clip.focus, zoom: clip.zoom, hdr: clip.hdr, info: clip.info },
          captionFile,
          audio: clip.audio,
        });
      } else {
        const file = join(workDir, `foto-${String(i).padStart(3, "0")}.jpg`);
        const prepared = await preparePhoto(
          item.file, file, Math.round(W * supersample), Math.round(H * supersample), preset.photo, item.focus, item.zoom,
        );
        fits.push(prepared.fit);
        const zoom = zoomRange(preset.motion, photoIndex);
        inputs.push(file);
        segments.push({
          kind: "photo",
          frames: timing.photoFrames[photoIndex]!,
          zoomFrom: zoom.from,
          zoomTo: zoom.to,
          pan: panDirection(preset.motion, photoIndex),
          focus: prepared.focus,
          captionFile,
        });
        photoIndex++;
      }
      progress((0.1 * (i + 1)) / count);
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
      }
    }

    let watermark;
    let titleLayout: TextLayout | undefined;
    const wm = preset.branding?.watermark;
    if (wm) {
      const logoFile = logos.get(wm.role);
      if (logoFile) {
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
          if (s.kind !== "card") {
            const from = (i === 0 ? 0 : startFrame + tf / 2) / fps;
            const to = (i === segments.length - 1 ? timing.totalFrames : endFrame - tf / 2) / fps;
            const last = windows.at(-1);
            if (last && segments[i - 1]!.kind !== "card") last.to = to;
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

    // -progress escreve "frame=N" na saída padrão; -nostats deixa o log de erros enxuto
    const args: string[] = ["-hide_banner", "-y", "-benchmark", "-nostats", "-progress", "pipe:1"];
    // Em containers, o FFmpeg enxerga os núcleos do host (ex.: 48) e não a cota do container
    // (ex.: 8). Com dezenas de entradas isso cria milhares de threads e o codificador não
    // consegue abrir. Por isso o limite é sempre explícito.
    const threads = req.encode?.threads ?? defaultThreads();
    if (!Number.isInteger(threads) || threads < 1 || threads > 64) {
      throw new EngineError("invalid_threads", "encode.threads deve ser um inteiro entre 1 e 64");
    }
    args.push("-filter_complex_threads", String(threads), "-filter_threads", String(threads));
    // Imagens: uma thread de decodificação basta. Clipes: duas, com a posição do trecho.
    for (const [index, file] of inputs.entries()) {
      args.push(...(inputOptions.get(index) ?? ["-threads", "1"]), "-i", file);
    }
    if (req.audio) args.push("-i", req.audio.file);
    args.push("-filter_complex", graph.graph, "-map", `[${graph.videoLabel}]`);
    if (graph.audioLabel) {
      args.push("-map", `[${graph.audioLabel}]`, "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2");
    }
    args.push(
      "-c:v", "libx264",
      "-preset", req.encode?.x264Preset ?? "medium",
      "-threads", String(threads),
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
    let pending = "";
    const res = await runFfmpeg(args, undefined, (chunk) => {
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const m = /^frame=(\d+)/.exec(line.trim());
        if (m) progress(0.1 + (0.9 * Number(m[1])) / timing.totalFrames);
      }
    });
    if (res.code !== 0) {
      throw new EngineError("render_failed", "O FFmpeg falhou ao renderizar o vídeo", {
        exitCode: res.code,
        stderr: summarizeFfmpegError(res.stderr),
      });
    }
    const finished = process.hrtime.bigint();
    progress(1);

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
      clips: [...clipPlans.values()].map((c) => ({
        item: c.item,
        start: c.start,
        end: round(c.start + c.length),
        hdr: c.hdr,
        keptAudio: c.audio !== undefined,
      })),
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
