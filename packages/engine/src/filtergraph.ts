import type { PhotoFilter, Preset } from "./preset.js";
import type { PlatformProfile } from "./platforms.js";
import type { TimingResult } from "./timing.js";

/** Formata números para o filtergraph sem notação científica nem zeros sobrando. */
export function n(value: number, digits = 4): string {
  return String(Number(value.toFixed(digits)));
}

/** Converte o parâmetro temperature (-1 frio .. 1 quente) para Kelvin do filtro colortemperature. */
export function temperatureToKelvin(temperature: number): number {
  // No filtro do FFmpeg, valores abaixo de 6500 K esquentam a imagem e acima esfriam.
  return temperature >= 0 ? 6500 - temperature * 3000 : 6500 + -temperature * 6000;
}

export function photoFilterToFfmpeg(filter: PhotoFilter): string[] {
  switch (filter.type) {
    case "color": {
      const out: string[] = [];
      const b = filter.brightness ?? 0;
      const c = filter.contrast ?? 1;
      const s = filter.saturation ?? 1;
      const t = filter.temperature ?? 0;
      if (b !== 0 || c !== 1 || s !== 1) {
        out.push(`eq=brightness=${n(b)}:contrast=${n(c)}:saturation=${n(s)}`);
      }
      if (t !== 0) out.push(`colortemperature=temperature=${n(temperatureToKelvin(t), 0)}`);
      return out;
    }
    case "vignette":
      if (filter.strength === 0) return [];
      // ângulo do filtro vai de 0 a PI/2; limitamos a 80% para não escurecer o centro
      return [`vignette=angle=${n(filter.strength * (Math.PI / 2) * 0.8)}`];
    case "grain":
      if (filter.amount === 0) return [];
      // ruído só na luminância, variando a cada quadro
      return [`noise=c0s=${n(filter.amount, 0)}:c0f=t+u`];
  }
}

/** Zoom inicial e final de uma foto, considerando a direção do preset. */
export function zoomRange(preset: Preset, photoIndex: number): { from: number; to: number } {
  const { motion } = preset;
  if (motion.type === "none") return { from: 1, to: 1 };
  const lo = Math.min(motion.zoomFrom, motion.zoomTo);
  const hi = Math.max(motion.zoomFrom, motion.zoomTo);
  const zoomIn = motion.direction === "in" || (motion.direction === "alternate" && photoIndex % 2 === 0);
  return zoomIn ? { from: lo, to: hi } : { from: hi, to: lo };
}

export interface FiltergraphInput {
  preset: Preset;
  platform: PlatformProfile;
  timing: TimingResult;
  photoCount: number;
  audio?: {
    /** Índice do input de áudio no comando do FFmpeg. */
    inputIndex: number;
    start: number;
    /** Quanto áudio usar a partir de start (<= duração do vídeo). */
    length: number;
  };
}

export interface Filtergraph {
  graph: string;
  videoLabel: string;
  audioLabel?: string;
}

/**
 * Monta o filter_complex: um ramo por foto (Ken Burns + filtros do preset),
 * transições encadeadas com xfade e o ramo de áudio (corte do trecho + fades).
 */
export function buildFiltergraph(input: FiltergraphInput): Filtergraph {
  const { preset, platform, timing, photoCount } = input;
  const { width, height, fps } = platform;
  const parts: string[] = [];

  const photoFilters = preset.photo.filters.flatMap(photoFilterToFfmpeg);

  for (let i = 0; i < photoCount; i++) {
    const { from, to } = zoomRange(preset, i);
    const frames = timing.clipFrames[i]!;
    const progress = frames > 1 ? `min(on/${frames - 1},1)` : "0";
    const zoom = from === to ? n(from) : `${n(from)}+(${n(to - from)})*${progress}`;
    const chain = [
      `zoompan=z='${zoom}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${width}x${height}:fps=${fps}`,
      ...photoFilters,
      "format=yuv420p",
      "setsar=1",
    ];
    parts.push(`[${i}:v]${chain.join(",")}[v${i}]`);
  }

  let videoLabel = "v0";
  if (photoCount > 1) {
    if (timing.transitionFrames === 0) {
      const inputs = Array.from({ length: photoCount }, (_, i) => `[v${i}]`).join("");
      parts.push(`${inputs}concat=n=${photoCount}:v=1:a=0[vcat]`);
      videoLabel = "vcat";
    } else {
      const duration = timing.transitionFrames / fps;
      // cada transição começa onde o clipe anterior termina, menos a sobreposição
      let offsetFrames = 0;
      for (let i = 1; i < photoCount; i++) {
        offsetFrames += timing.clipFrames[i - 1]! - timing.transitionFrames;
        const out = `x${i}`;
        parts.push(
          `[${videoLabel}][v${i}]xfade=transition=${preset.transition.type}:duration=${n(duration, 6)}:offset=${n(offsetFrames / fps, 6)}[${out}]`,
        );
        videoLabel = out;
      }
    }
  }

  let audioLabel: string | undefined;
  if (input.audio) {
    const { inputIndex, start, length } = input.audio;
    // Os fades nunca ocupam mais que o trecho inteiro.
    const fadeTotal = preset.audio.fadeIn + preset.audio.fadeOut;
    const scale = fadeTotal > length ? length / fadeTotal : 1;
    const fadeIn = preset.audio.fadeIn * scale;
    const fadeOut = preset.audio.fadeOut * scale;

    const chain = [
      `atrim=start=${n(start, 6)}:end=${n(start + length, 6)}`,
      "asetpts=PTS-STARTPTS",
      "aresample=48000",
    ];
    if (fadeIn > 0) chain.push(`afade=t=in:st=0:d=${n(fadeIn, 6)}`);
    if (fadeOut > 0) chain.push(`afade=t=out:st=${n(length - fadeOut, 6)}:d=${n(fadeOut, 6)}`);
    if (preset.audio.volume !== 1) chain.push(`volume=${n(preset.audio.volume)}`);
    // completa com silêncio até a duração exata do vídeo (diferenças de arredondamento de quadro)
    chain.push(`apad=whole_dur=${n(timing.total, 6)}`);
    audioLabel = "aout";
    parts.push(`[${inputIndex}:a]${chain.join(",")}[${audioLabel}]`);
  }

  return { graph: parts.join(";"), videoLabel, audioLabel };
}
