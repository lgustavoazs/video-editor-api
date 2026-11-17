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
  /** Duração (s) de cada cartão de logo que entra na linha do tempo. */
  cards?: number[];
  /** Duração (s) do trecho usado de cada clipe de vídeo, na ordem da linha do tempo. */
  clips?: number[];
}

export interface TimingResult {
  /** Duração final do vídeo, em segundos (múltiplo exato de 1/fps). */
  total: number;
  totalFrames: number;
  /** Quadros de cada foto (podem diferir em 1 para a soma fechar exata). */
  photoFrames: number[];
  /** Quadros de cada cartão, na ordem recebida. */
  cardFrames: number[];
  /** Quadros de cada clipe, na ordem recebida. */
  clipFrames: number[];
  transitionFrames: number;
  /** Tempo médio em que cada foto fica visível sem estar em transição. */
  visiblePerPhoto: number;
  warnings: string[];
}

/**
 * Regra de duração proporcional (seção 9 do documento de projeto).
 *
 * A linha do tempo tem S segmentos (N fotos + K cartões e clipes) unidos por S-1
 * transições de t segundos, que se sobrepõem. Cartões e clipes têm duração fixa
 * C (soma); as fotos dividem o resto: cada uma dura d = (T + (S-1)·t - C) / N,
 * e fica visível d - t.
 *
 * Sem fotos, a duração do vídeo é a soma dos clipes e cartões (menos as transições).
 */
export function computeTiming(input: TimingInput): TimingResult {
  const { photoCount: n, fps, perPhotoMin, perPhotoMax, maxDuration, mode, segment } = input;
  const cards = input.cards ?? [];
  const clips = input.clips ?? [];
  if (!Number.isInteger(n) || n < 0 || n + clips.length < 1) {
    throw new EngineError("no_photos", "Informe ao menos um item (foto ou clipe)");
  }
  const warnings: string[] = [];
  const k = cards.length + clips.length;
  const segments = n + k;
  const t = segments > 1 ? input.transition : 0;
  const transitionFrames = Math.round(t * fps);
  // Cada segmento precisa caber entre duas transições.
  const minSegmentFrames = 2 * transitionFrames + 1;
  const cardFrames = cards.map((c) => Math.max(Math.round(c * fps), minSegmentFrames));
  // Clipes não são esticados: quadros a mais não existem no arquivo.
  const clipFrames = clips.map((c, i) => {
    const frames = Math.floor(c * fps + 1e-6);
    if (frames < minSegmentFrames) {
      const minimum = Math.ceil((minSegmentFrames / fps) * 100) / 100;
      throw new EngineError(
        "clip_too_short",
        `O clipe ${i + 1} tem ${c.toFixed(2)} s; com transições de ${t} s, o mínimo é ${minimum} s.`,
        { clip: i, length: c, minimum },
      );
    }
    return frames;
  });
  const fixedFrames = [...cardFrames, ...clipFrames].reduce((a, b) => a + b, 0);
  const fixedTotal = fixedFrames / fps;

  // Só clipes (e cartões): a duração é a deles.
  if (n === 0) {
    const totalFrames = fixedFrames - (segments - 1) * transitionFrames;
    const total = totalFrames / fps;
    if (total > maxDuration + 1e-6) {
      throw new EngineError(
        "video_too_long",
        `Os clipes e cartões somam ${total.toFixed(2)} s; o máximo da plataforma é ${maxDuration} s.`,
        { total, maxDuration },
      );
    }
    if (mode === "audio" && !segment) {
      throw new EngineError("audio_required", 'O modo de duração "audio" exige uma faixa de áudio');
    }
    if (mode === "fixed" && input.requestedTotal !== undefined && Math.abs(input.requestedTotal - total) > 1 / fps) {
      warnings.push(`Sem fotos, a duração é a soma dos clipes e cartões: ${total.toFixed(2)} s.`);
    }
    if (segment && segment.length < total - 1e-6 && !segment.loop) {
      throw new EngineError(
        "audio_segment_too_short",
        "O trecho de áudio é mais curto que os clipes. Aumente o trecho ou use loop.",
        { segmentLength: segment.length, requestedTotal: total },
      );
    }
    return { total, totalFrames, photoFrames: [], cardFrames, clipFrames, transitionFrames, visiblePerPhoto: 0, warnings };
  }

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

  // Tempo visível por foto: (T + (K-1)·t - C) / N. Sem cartões e clipes, vira (T - t) / N.
  const available = total + (k - 1) * t - fixedTotal;
  let visible = available / n;
  if (visible < perPhotoMin - 1e-6) {
    const maxPhotos = Math.max(0, Math.floor(available / perPhotoMin + 1e-6));
    const missing = n * perPhotoMin - available;
    throw new EngineError(
      "too_many_photos",
      `Fotos demais para ${total.toFixed(2)} s: cada foto ficaria visível por menos de ${perPhotoMin} s` +
        (k > 0 ? ` (cartões e clipes ocupam ${fixedTotal.toFixed(2)} s).` : "."),
      { photoCount: n, maxPhotos, total, missingSeconds: Math.round(missing * 100) / 100 },
    );
  }
  if (visible > perPhotoMax + 1e-6) {
    const reduced = n * perPhotoMax - (k - 1) * t + fixedTotal;
    warnings.push(
      `Poucas fotos para ${total.toFixed(2)} s: a duração foi reduzida para ${reduced.toFixed(2)} s ` +
        `(máximo de ${perPhotoMax} s por foto).`,
    );
    total = reduced;
    visible = perPhotoMax;
  }

  // Quantiza em quadros. O total é fixado primeiro e o resto da divisão é distribuído
  // entre as primeiras fotos, para a duração final bater com a pedida.
  const totalFrames = Math.max(
    n * minSegmentFrames + fixedFrames - (segments - 1) * transitionFrames,
    Math.round(total * fps),
  );
  const framesToSplit = totalFrames + (segments - 1) * transitionFrames - fixedFrames;
  const baseFrames = Math.floor(framesToSplit / n);
  const remainder = framesToSplit - baseFrames * n;
  const photoFrames = Array.from({ length: n }, (_, i) => baseFrames + (i < remainder ? 1 : 0));

  return {
    total: totalFrames / fps,
    totalFrames,
    photoFrames,
    cardFrames,
    clipFrames,
    transitionFrames,
    visiblePerPhoto: baseFrames / fps - transitionFrames / fps,
    warnings,
  };
}
