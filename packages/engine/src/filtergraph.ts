import { n, photoFilterToFfmpeg, quote, type FilterContext } from "./filters.js";
import type { PlatformProfile } from "./platforms.js";
import type { Focus } from "./prepare.js";
import type { Preset, TextStyle } from "./preset.js";
import { drawText, type TextLayout } from "./text.js";

export type PanDirection = "none" | "left" | "right" | "up" | "down";

export interface PhotoSegment {
  kind: "photo";
  frames: number;
  zoomFrom: number;
  zoomTo: number;
  pan: PanDirection;
  focus: Focus;
  /** Arquivo com a legenda já quebrada em linhas. */
  captionFile?: string;
}

export interface CardSegment {
  kind: "card";
  frames: number;
  caption?: { textFile: string; y: number; color: string };
}

/** Um trecho da linha do tempo. O índice na lista é o índice do input no FFmpeg. */
export type Segment = PhotoSegment | CardSegment;

/** Zoom inicial e final de uma foto, considerando a direção do preset. */
export function zoomRange(motion: Preset["motion"], photoIndex: number): { from: number; to: number } {
  if (motion.type === "none") return { from: 1, to: 1 };
  const lo = Math.min(motion.zoomFrom, motion.zoomTo);
  const hi = Math.max(motion.zoomFrom, motion.zoomTo);
  const zoomIn = motion.direction === "in" || (motion.direction === "alternate" && photoIndex % 2 === 0);
  return zoomIn ? { from: lo, to: hi } : { from: hi, to: lo };
}

/** Deslocamento de uma foto, considerando o modo do preset. */
export function panDirection(motion: Preset["motion"], photoIndex: number): PanDirection {
  if (motion.type === "none" || motion.pan === "none") return "none";
  if (motion.pan === "alternate") return photoIndex % 2 === 0 ? "right" : "left";
  return motion.pan;
}

function zoompan(segment: Segment, width: number, height: number, fps: number): string {
  const frames = segment.frames;
  if (segment.kind === "card") {
    return `zoompan=z=1:x=0:y=0:d=${frames}:s=${width}x${height}:fps=${fps}`;
  }
  const { zoomFrom: from, zoomTo: to, pan, focus } = segment;
  const progress = frames > 1 ? `min(on/${frames - 1},1)` : "0";
  const zoom = from === to ? n(from) : `${n(from)}+(${n(to - from)})*${progress}`;
  // sem deslocamento, a janela fica centrada no ponto de interesse, sem sair da imagem
  let x = `max(0,min(iw-iw/zoom,${n(focus.x)}*iw-iw/zoom/2))`;
  let y = `max(0,min(ih-ih/zoom,${n(focus.y)}*ih-ih/zoom/2))`;
  // com deslocamento, a janela percorre toda a folga que o zoom deixa naquele eixo
  if (pan === "right") x = `(iw-iw/zoom)*${progress}`;
  if (pan === "left") x = `(iw-iw/zoom)*(1-${progress})`;
  if (pan === "down") y = `(ih-ih/zoom)*${progress}`;
  if (pan === "up") y = `(ih-ih/zoom)*(1-${progress})`;
  return `zoompan=z='${zoom}':x='${x}':y='${y}':d=${frames}:s=${width}x${height}:fps=${fps}`;
}

export interface FiltergraphInput {
  preset: Preset;
  platform: PlatformProfile;
  segments: Segment[];
  /** Transição de cada passagem entre segmentos (segments.length - 1 itens). */
  transitions: string[];
  transitionFrames: number;
  /** Duração final do vídeo, em segundos. */
  total: number;
  filterContext: FilterContext;
  fontsDir: string;
  layout: TextLayout;
  title?: { textFile: string };
  watermark?: {
    inputIndex: number;
    x: number;
    y: number;
    opacity: number;
    /** Janelas (em segundos) em que a marca d'água aparece: ela fica fora dos cartões de logo. */
    windows: { from: number; to: number }[];
  };
  /** Margens do título, quando diferem das do restante do texto (ex.: para não cobrir a marca d'água). */
  titleLayout?: TextLayout;
  audio?: {
    inputIndex: number;
    start: number;
    /** Duração do trecho escolhido. */
    segmentLength: number;
    loop: boolean;
  };
}

export interface Filtergraph {
  graph: string;
  videoLabel: string;
  audioLabel?: string;
}

const CARD_CAPTION_STYLE: Omit<TextStyle, "color"> = {
  font: "sans-bold",
  size: 0.03,
  position: "center",
  box: false,
  boxColor: "#000000",
  boxOpacity: 0,
};

/**
 * Monta o filter_complex: um ramo por segmento (Ken Burns + filtros nas fotos),
 * transições encadeadas com xfade, acabamento (barras, título, marca d'água)
 * e o ramo de áudio (corte do trecho, loop, fades).
 */
export function buildFiltergraph(input: FiltergraphInput): Filtergraph {
  const { preset, platform, segments, layout } = input;
  const { width, height, fps } = platform;
  const parts: string[] = [];
  const photoFilters = preset.photo.filters.flatMap((f) => photoFilterToFfmpeg(f, input.filterContext));

  segments.forEach((segment, i) => {
    const chain = [zoompan(segment, width, height, fps)];
    if (segment.kind === "photo") {
      chain.push(...photoFilters);
      if (segment.captionFile && preset.text?.caption) {
        chain.push(
          drawText({ style: preset.text.caption, layout, textFile: segment.captionFile, fontsDir: input.fontsDir }),
        );
      }
    } else if (segment.caption) {
      chain.push(
        drawText({
          style: { ...CARD_CAPTION_STYLE, color: segment.caption.color },
          layout,
          textFile: segment.caption.textFile,
          fontsDir: input.fontsDir,
          fixedY: segment.caption.y,
        }),
      );
    }
    chain.push("format=yuv420p", "setsar=1");
    parts.push(`[${i}:v]${chain.join(",")}[v${i}]`);
  });

  let videoLabel = "v0";
  if (segments.length > 1) {
    if (input.transitionFrames === 0) {
      const inputs = segments.map((_, i) => `[v${i}]`).join("");
      parts.push(`${inputs}concat=n=${segments.length}:v=1:a=0[vcat]`);
      videoLabel = "vcat";
    } else {
      const duration = input.transitionFrames / fps;
      // cada transição começa onde o trecho anterior termina, menos a sobreposição
      let offsetFrames = 0;
      for (let i = 1; i < segments.length; i++) {
        offsetFrames += segments[i - 1]!.frames - input.transitionFrames;
        const out = `x${i}`;
        parts.push(
          `[${videoLabel}][v${i}]xfade=transition=${input.transitions[i - 1]}:duration=${n(duration, 6)}:offset=${n(offsetFrames / fps, 6)}[${out}]`,
        );
        videoLabel = out;
      }
    }
  }

  // Acabamento sobre o vídeo já montado.
  const finish: string[] = [];
  if (preset.letterbox > 0) {
    const bar = Math.round(preset.letterbox * height);
    finish.push(
      `drawbox=x=0:y=0:w=iw:h=${bar}:color=black:t=fill`,
      `drawbox=x=0:y=ih-${bar}:w=iw:h=${bar}:color=black:t=fill`,
    );
  }
  if (input.title && preset.text?.title) {
    const style = preset.text.title;
    const end = Math.min(input.total, style.start + style.duration);
    finish.push(
      drawText({
        style,
        layout: input.titleLayout ?? layout,
        textFile: input.title.textFile,
        fontsDir: input.fontsDir,
        window: { start: style.start, end, fade: Math.min(style.fade, (end - style.start) / 2) },
      }),
    );
  }
  if (finish.length > 0) {
    parts.push(`[${videoLabel}]${finish.join(",")}[vfin]`);
    videoLabel = "vfin";
  }
  if (input.watermark) {
    const w = input.watermark;
    const logo = `format=rgba${w.opacity < 1 ? `,colorchannelmixer=aa=${n(w.opacity, 3)}` : ""}`;
    parts.push(`[${w.inputIndex}:v]${logo}[wm]`);
    parts.push(
      `[${videoLabel}][wm]overlay=x=${Math.round(w.x)}:y=${Math.round(w.y)}:enable=${quote(w.windows.map((x) => `between(t,${n(x.from)},${n(x.to)})`).join("+"))}:format=auto,format=yuv420p[vwm]`,
    );
    videoLabel = "vwm";
  }

  let audioLabel: string | undefined;
  if (input.audio) {
    const { inputIndex, start, segmentLength, loop } = input.audio;
    const total = input.total;
    const used = Math.min(segmentLength, total);
    const needsLoop = loop && segmentLength < total - 1e-6;
    const audible = needsLoop ? total : used;

    // Os fades nunca ocupam mais que o áudio inteiro.
    const fadeTotal = preset.audio.fadeIn + preset.audio.fadeOut;
    const scale = fadeTotal > audible ? audible / fadeTotal : 1;
    const fadeIn = preset.audio.fadeIn * scale;
    const fadeOut = preset.audio.fadeOut * scale;

    const chain = [
      `atrim=start=${n(start, 6)}:end=${n(start + used, 6)}`,
      "asetpts=PTS-STARTPTS",
      "aresample=48000",
    ];
    if (needsLoop) {
      // repete o trecho inteiro quantas vezes for preciso e corta na duração do vídeo
      chain.push(
        `aloop=loop=-1:size=${Math.round(used * 48000)}`,
        `atrim=end=${n(total, 6)}`,
        "asetpts=PTS-STARTPTS",
      );
    }
    if (fadeIn > 0) chain.push(`afade=t=in:st=0:d=${n(fadeIn, 6)}`);
    if (fadeOut > 0) chain.push(`afade=t=out:st=${n(audible - fadeOut, 6)}:d=${n(fadeOut, 6)}`);
    if (preset.audio.volume !== 1) chain.push(`volume=${n(preset.audio.volume)}`);
    // completa com silêncio até a duração exata do vídeo (diferenças de arredondamento de quadro)
    chain.push(`apad=whole_dur=${n(total, 6)}`);
    audioLabel = "aout";
    parts.push(`[${inputIndex}:a]${chain.join(",")}[${audioLabel}]`);
  }

  return { graph: parts.join(";"), videoLabel, audioLabel };
}
