import { EngineError } from "./errors.js";

/** Aceita segundos (número ou "42.5") ou "mm:ss(.mmm)" / "hh:mm:ss(.mmm)". */
export function parseTime(value: number | string, field = "tempo"): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) {
      throw new EngineError("invalid_time", `${field}: valor inválido`, { value });
    }
    return value;
  }
  const s = value.trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/.exec(s);
  if (!m) {
    throw new EngineError("invalid_time", `${field}: use segundos ou "mm:ss.mmm"`, { value });
  }
  const hours = m[1] ? Number(m[1]) : 0;
  const minutes = Number(m[2]);
  const seconds = Number(m[3]);
  if (seconds >= 60 || (m[1] !== undefined && minutes >= 60)) {
    throw new EngineError("invalid_time", `${field}: minutos/segundos devem ser menores que 60`, { value });
  }
  return hours * 3600 + minutes * 60 + seconds;
}

export interface AudioSegmentInput {
  start?: number | string;
  end?: number | string;
  duration?: number | string;
  loop?: boolean;
}

export interface AudioSegment {
  start: number;
  end: number;
  length: number;
  loop: boolean;
}

export const MIN_SEGMENT_SECONDS = 3;

/** Resolve e valida o trecho do áudio contra a duração real da faixa. */
export function resolveAudioSegment(input: AudioSegmentInput, trackDuration: number): AudioSegment {
  if (input.end !== undefined && input.duration !== undefined) {
    throw new EngineError("invalid_audio_segment", '"end" e "duration" são mutuamente exclusivos');
  }
  const start = input.start === undefined ? 0 : parseTime(input.start, "audio.start");
  if (start >= trackDuration) {
    throw new EngineError("audio_segment_out_of_range", "audio.start está além do fim da faixa", {
      start,
      trackDuration,
    });
  }
  let end = trackDuration;
  if (input.end !== undefined) end = parseTime(input.end, "audio.end");
  else if (input.duration !== undefined) end = start + parseTime(input.duration, "audio.duration");

  if (end <= start) {
    throw new EngineError("invalid_audio_segment", "audio.end deve ser maior que audio.start", { start, end });
  }
  // tolerância de 50 ms para arredondamentos de quem informa a duração da faixa
  if (end > trackDuration + 0.05) {
    throw new EngineError("audio_segment_out_of_range", "O trecho termina depois do fim da faixa", {
      end,
      trackDuration,
    });
  }
  end = Math.min(end, trackDuration);
  const length = end - start;
  if (length < MIN_SEGMENT_SECONDS) {
    throw new EngineError("audio_segment_too_short", `O trecho mínimo é de ${MIN_SEGMENT_SECONDS} s`, {
      length,
      minimum: MIN_SEGMENT_SECONDS,
    });
  }
  return { start, end, length, loop: input.loop ?? false };
}

export interface TimingInput {
  photoCount: number;
  fps: number;
  /** Duração da transição do preset, em segundos. */
  transition: number;
  perPhotoMin: number;
  perPhotoMax: number;
  /** Máximo da plataforma, em segundos. */
  maxDuration: number;
  mode: "audio" | "fixed";
  /** Obrigatório no modo "fixed". */
  requestedTotal?: number;
  /** Trecho de áudio já resolvido, se houver áudio. */
  segment?: AudioSegment;
}

export interface TimingResult {
  /** Duração final do vídeo, em segundos (múltiplo exato de 1/fps). */
  total: number;
  totalFrames: number;
  /** Quadros de cada clipe (podem diferir em 1 para a soma fechar exata). */
  clipFrames: number[];
  transitionFrames: number;
  /** Tempo em que cada foto fica visível sem estar em transição. */
  visiblePerPhoto: number;
  warnings: string[];
}

/**
 * Regra de duração proporcional (seção 9 do documento de projeto).
 * Com N fotos e transição t, cada clipe dura d = (T + (N-1)·t) / N,
 * porque as transições se sobrepõem. O tempo visível por foto é (T - t) / N.
 */
export function computeTiming(input: TimingInput): TimingResult {
  const { photoCount: n, fps, perPhotoMin, perPhotoMax, maxDuration, mode, segment } = input;
  if (!Number.isInteger(n) || n < 1) {
    throw new EngineError("no_photos", "Informe ao menos uma foto");
  }
  const warnings: string[] = [];
  const t = n > 1 ? input.transition : 0;

  let total: number;
  if (mode === "audio") {
    if (!segment) {
      throw new EngineError("audio_required", 'O modo de duração "audio" exige uma faixa de áudio');
    }
    total = segment.length;
    if (total > maxDuration) {
      warnings.push(
        `O trecho de áudio (${total.toFixed(2)} s) excede o máximo da plataforma (${maxDuration} s) e foi cortado.`,
      );
      total = maxDuration;
    }
  } else {
    if (input.requestedTotal === undefined || !(input.requestedTotal > 0)) {
      throw new EngineError("total_required", 'O modo de duração "fixed" exige a duração total');
    }
    total = input.requestedTotal;
    if (total > maxDuration) {
      warnings.push(
        `A duração pedida (${total.toFixed(2)} s) excede o máximo da plataforma (${maxDuration} s) e foi reduzida.`,
      );
      total = maxDuration;
    }
    if (segment && total > segment.length + 1e-6 && !segment.loop) {
      throw new EngineError(
        "audio_segment_too_short",
        "O trecho de áudio é mais curto que a duração pedida. Aumente o trecho ou use loop.",
        { segmentLength: segment.length, requestedTotal: total },
      );
    }
  }

  let visible = (total - t) / n;
  if (visible < perPhotoMin - 1e-6) {
    const maxPhotos = Math.max(0, Math.floor((total - t) / perPhotoMin + 1e-6));
    throw new EngineError(
      "too_many_photos",
      `Fotos demais para ${total.toFixed(2)} s: cada foto ficaria visível por menos de ${perPhotoMin} s.`,
      { photoCount: n, maxPhotos, total },
    );
  }
  if (visible > perPhotoMax + 1e-6) {
    const reduced = n * perPhotoMax + t;
    warnings.push(
      `Poucas fotos para ${total.toFixed(2)} s: a duração foi reduzida para ${reduced.toFixed(2)} s ` +
        `(máximo de ${perPhotoMax} s por foto).`,
    );
    total = reduced;
    visible = perPhotoMax;
  }

  // Quantiza em quadros. O total é fixado primeiro e o resto da divisão é distribuído
  // entre os primeiros clipes, para a duração final bater com a pedida.
  const transitionFrames = n > 1 ? Math.round(t * fps) : 0;
  const totalFrames = Math.max(n * (transitionFrames + 1), Math.round(total * fps));
  const framesToSplit = totalFrames + (n - 1) * transitionFrames;
  const baseFrames = Math.floor(framesToSplit / n);
  const remainder = framesToSplit - baseFrames * n;
  const clipFrames = Array.from({ length: n }, (_, i) => baseFrames + (i < remainder ? 1 : 0));

  return {
    total: totalFrames / fps,
    totalFrames,
    clipFrames,
    transitionFrames,
    visiblePerPhoto: (totalFrames / fps - transitionFrames / fps) / n,
    warnings,
  };
}
