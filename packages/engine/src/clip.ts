import { EngineError } from "./errors.js";
import type { ClipInfo } from "./ffmpeg.js";
import { n, quote } from "./filters.js";
import type { Focus } from "./prepare.js";
import type { Preset } from "./preset.js";
import { parseTime } from "./timing.js";

/** Máximo de clipes por vídeo (o total de itens continua limitado a MAX_ITEMS). */
export const MAX_CLIPS = 10;
/** Duração mínima do trecho usado de um clipe. */
export const MIN_CLIP_SECONDS = 1;
/** Lado maior aceito (4K). Vídeos 8K pesam demais para o container. */
export const MAX_CLIP_SIDE = 4096;

export interface ClipRangeInput {
  start?: number | string;
  end?: number | string;
  duration?: number | string;
}

/** Resolve e valida o trecho usado de um clipe contra a duração real do arquivo. */
export function resolveClipRange(
  input: ClipRangeInput,
  sourceDuration: number,
  item: number,
): { start: number; length: number } {
  const field = `items[${item}]`;
  if (input.end !== undefined && input.duration !== undefined) {
    throw new EngineError("invalid_clip", `${field}: "end" e "duration" são mutuamente exclusivos`, { item });
  }
  const start = input.start === undefined ? 0 : parseTime(input.start, `${field}.start`);
  if (start >= sourceDuration) {
    throw new EngineError("clip_out_of_range", `${field}.start está além do fim do clipe`, {
      item, start, clipDuration: sourceDuration,
    });
  }
  let end = sourceDuration;
  if (input.end !== undefined) end = parseTime(input.end, `${field}.end`);
  else if (input.duration !== undefined) end = start + parseTime(input.duration, `${field}.duration`);
  if (end <= start) {
    throw new EngineError("invalid_clip", `${field}.end deve ser maior que ${field}.start`, { item, start, end });
  }
  // tolerância de 50 ms para quem informa a duração do arquivo arredondada
  if (end > sourceDuration + 0.05) {
    throw new EngineError("clip_out_of_range", `${field}: o trecho termina depois do fim do clipe`, {
      item, end, clipDuration: sourceDuration,
    });
  }
  const length = Math.min(end, sourceDuration) - start;
  if (length < MIN_CLIP_SECONDS) {
    throw new EngineError("clip_too_short", `${field}: o trecho mínimo de um clipe é de ${MIN_CLIP_SECONDS} s`, {
      item, length, minimum: MIN_CLIP_SECONDS,
    });
  }
  return { start, length };
}

/** Dimensões exibidas do clipe, já com a rotação e a proporção do pixel aplicadas. */
export function displaySize(info: ClipInfo): { width: number; height: number } {
  const width = Math.round(info.width * info.sampleAspect);
  const swap = info.rotation === 90 || info.rotation === 270;
  return swap ? { width: info.height, height: width } : { width, height: info.height };
}

const HDR_TRANSFERS = new Set(["smpte2084", "arib-std-b67"]);

/** HDR = transferência PQ (smpte2084) ou HLG (arib-std-b67), como gravam iPhones e Androids recentes. */
export function isHdr(info: ClipInfo): boolean {
  return info.colorTransfer !== undefined && HDR_TRANSFERS.has(info.colorTransfer);
}

// Nomes que o ffprobe devolve e que o zscale aceita como estão.
const ZSCALE_PRIMARIES = new Set(["bt709", "bt2020", "smpte170m", "smpte240m", "bt470bg", "smpte432"]);
const ZSCALE_MATRICES = new Set(["bt709", "bt2020nc", "bt2020c", "smpte170m", "bt470bg", "smpte240m"]);

/**
 * Conversão de HDR para SDR (BT.709): lineariza, converte as primárias,
 * comprime os realces com a curva "mobius" e volta para vídeo comum.
 * Sem isso, vídeos HDR de celular saem com cores lavadas.
 *
 * A curva "mobius" preserva os tons médios; em teste com PQ e HLG sintéticos ficou
 * mais próxima do original que "hable" e "reinhard". Cada etapa declara a cor de
 * entrada, porque o zscale nem sempre herda a marcação da etapa anterior.
 */
export function hdrToSdr(info: ClipInfo): string[] {
  const tin = info.colorTransfer!;
  const pin = info.colorPrimaries && ZSCALE_PRIMARIES.has(info.colorPrimaries) ? info.colorPrimaries : "bt2020";
  const min = info.colorSpace && ZSCALE_MATRICES.has(info.colorSpace) ? info.colorSpace : "bt2020nc";
  return [
    `zscale=tin=${tin}:pin=${pin}:min=${min}:t=linear:npl=100`,
    "format=gbrpf32le",
    `zscale=tin=linear:pin=${pin}:p=bt709`,
    "tonemap=tonemap=mobius:desat=0",
    "zscale=tin=linear:pin=bt709:t=bt709:m=bt709:r=tv",
    "format=yuv420p",
  ];
}

export interface ClipVideoInput {
  /** Índice do input no FFmpeg (e do segmento na linha do tempo). */
  index: number;
  frames: number;
  fit: "cover" | "contain";
  focus: Focus;
  /** Converter de HDR para SDR. */
  hdr: boolean;
  info: ClipInfo;
}

/**
 * Ramo de vídeo de um clipe: conversão de cor, taxa de quadros do perfil, enquadramento
 * (corte com foco ou foto inteira sobre fundo) e os mesmos filtros de cor das fotos.
 * Devolve as partes do filtergraph e o rótulo onde o ramo termina, antes do acabamento.
 */
export function clipVideoParts(
  clip: ClipVideoInput,
  photo: Preset["photo"],
  width: number,
  height: number,
  fps: number,
): { parts: string[]; label: string } {
  const i = clip.index;
  const pre: string[] = [];
  if (clip.hdr) pre.push(...hdrToSdr(clip.info));
  if (Math.abs(clip.info.sampleAspect - 1) > 1e-3) pre.push("scale=trunc(iw*sar/2)*2:ih", "setsar=1");
  pre.push("setpts=PTS-STARTPTS", `fps=${fps}`, "format=yuv420p");

  if (clip.fit === "cover") {
    const { x, y } = clip.focus;
    // a janela fica centrada no ponto de interesse, sem sair do quadro
    const crop = `crop=${width}:${height}:x=${quote(`max(0,min(iw-ow,${n(x)}*iw-ow/2))`)}:y=${quote(`max(0,min(ih-oh,${n(y)}*ih-oh/2))`)}`;
    const label = `c${i}`;
    return {
      parts: [
        `[${i}:v]${[...pre, `scale=${width}:${height}:force_original_aspect_ratio=increase:force_divisible_by=2`, crop].join(",")}[${label}]`,
      ],
      label,
    };
  }

  const inside = `scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2`;
  const label = `c${i}`;
  if (photo.background.type === "color") {
    const color = `0x${photo.background.color.slice(1)}`;
    return {
      parts: [`[${i}:v]${[...pre, inside, `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=${color}`].join(",")}[${label}]`],
      label,
    };
  }
  // fundo: o próprio clipe ampliado, desfocado em resolução reduzida (bem mais rápido) e escurecido
  const smallW = 2 * Math.max(8, Math.round(width / 16));
  const smallH = 2 * Math.max(8, Math.round(height / 16));
  const sigma = (photo.background.blur * smallW) / width;
  const bg = [
    `scale=${smallW}:${smallH}:force_original_aspect_ratio=increase`,
    `crop=${smallW}:${smallH}`,
  ];
  if (sigma >= 0.3) bg.push(`gblur=sigma=${n(sigma, 3)}`);
  const k = 1 - photo.background.darken;
  if (k < 1) bg.push(`lutyuv=y=${quote(`val*${n(k, 3)}`)}:u=${quote(`128+(val-128)*${n(k, 3)}`)}:v=${quote(`128+(val-128)*${n(k, 3)}`)}`);
  bg.push(`scale=${width}:${height}`);
  return {
    parts: [
      `[${i}:v]${pre.join(",")},split=2[ca${i}][cb${i}]`,
      `[ca${i}]${bg.join(",")}[cbg${i}]`,
      `[cb${i}]${inside}[cfg${i}]`,
      `[cbg${i}][cfg${i}]overlay=(W-w)/2:(H-h)/2[${label}]`,
    ],
    label,
  };
}
