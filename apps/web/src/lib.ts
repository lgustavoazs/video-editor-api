/**
 * Funções puras do site (sem React nem DOM), testadas em test/lib.test.ts.
 */

export type ItemKind = "photo" | "clip";

export interface Focus {
  x: number;
  y: number;
}

export interface DraftItem {
  id: string;
  kind: ItemKind;
  file: File;
  /** Endereço local (blob:) para mostrar a miniatura. */
  url: string;
  width?: number;
  height?: number;
  focus?: Focus;
  /** Aproximação do enquadramento (1 = sem zoom). */
  zoom?: number;
  caption: string;
  /** Clipes: duração do arquivo e trecho escolhido, em segundos. */
  sourceDuration?: number;
  start?: number;
  end?: number;
  keepAudio: boolean;
  volume: number;
}

export type MusicChoice =
  | { kind: "none"; duration: number }
  | { kind: "file"; file: File; start: number; end: number; loop: boolean }
  | { kind: "library"; id: string; start: number; end: number; loop: boolean };

export interface Draft {
  preset: string;
  platform: string;
  title: string;
  items: DraftItem[];
  music: MusicChoice;
  /** Entrada e saída da música, em segundos (0 = corte seco). Ausente = padrão do estilo. */
  fades: { fadeIn?: number; fadeOut?: number };
  logos: { brand?: File; partner?: File };
}

export const MAX_ZOOM = 4;

/** Opções de entrada e saída da música oferecidas na tela. */
export const FADE_CHOICES = [0, 0.5, 1, 2, 3];

/** Arredonda segundos para milésimos (o servidor quantiza em quadros). */
export const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** "1:05.3" a partir de segundos. */
export function formatTime(seconds: number, decimals = 1): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  const text = s.toFixed(decimals);
  return `${m}:${s < 10 ? "0" : ""}${text}`;
}

/** Aceita "65", "65.5", "1:05", "1:05.5" (vírgula também vale como decimal). */
export function parseTime(text: string): number | undefined {
  const t = text.trim().replace(",", ".");
  if (!t) return undefined;
  const m = /^(?:(\d+):)?(\d+(?:\.\d+)?)$/.exec(t);
  if (!m) return undefined;
  const min = m[1] ? Number(m[1]) : 0;
  const sec = Number(m[2]);
  if (m[1] && sec >= 60) return undefined;
  return min * 60 + sec;
}

/**
 * Área que fica visível quando a foto é cortada para o formato da plataforma
 * (modo "cover"), centrada no ponto de interesse. Valores em fração (0 a 1)
 * da largura e da altura da foto. Mesma regra do motor.
 */
export function cropRect(imgW: number, imgH: number, targetAspect: number, focus: Focus = { x: 0.5, y: 0.5 }, zoom = 1) {
  const imgAspect = imgW / imgH;
  let w = 1;
  let h = 1;
  if (imgAspect > targetAspect) w = targetAspect / imgAspect;
  else h = imgAspect / targetAspect;
  // Zoom: a mesma janela, menor (mostra uma área menor, ampliada no vídeo).
  w /= zoom;
  h /= zoom;
  const clamp = (v: number, size: number) => Math.min(1 - size, Math.max(0, v - size / 2));
  return { x: clamp(focus.x, w), y: clamp(focus.y, h), w, h };
}

/** Quanto da foto o corte remove (0 a 1). Usado para avisar quando é muito. */
export function cropLoss(imgW: number, imgH: number, targetAspect: number): number {
  const r = cropRect(imgW, imgH, targetAspect);
  return 1 - r.w * r.h;
}

export const PLATFORM_LABELS: Record<string, string> = {
  instagram_reels: "Instagram Reels",
  facebook_reels: "Facebook Reels",
  facebook_feed: "Facebook (feed)",
  instagram_feed: "Instagram (feed)",
  tiktok: "TikTok",
  youtube_shorts: "YouTube Shorts",
};

export const LIMITS_MB = { photo: 15, clip: 200, audio: 20, logo: 5, total: 500 };
const MB = 1024 * 1024;

/** Problemas que dá para apontar antes de enviar (o servidor confere tudo de novo). */
export function validateDraft(d: Draft): string[] {
  const errors: string[] = [];
  if (d.items.length === 0) errors.push("Adicione pelo menos uma foto ou clipe.");
  if (d.items.length > 30) errors.push("No máximo 30 fotos e clipes por vídeo.");
  const clips = d.items.filter((i) => i.kind === "clip");
  if (clips.length > 10) errors.push("No máximo 10 clipes por vídeo.");
  d.items.forEach((it, i) => {
    const limit = it.kind === "photo" ? LIMITS_MB.photo : LIMITS_MB.clip;
    if (it.file.size > limit * MB) errors.push(`Item ${i + 1} (${it.file.name}) passa de ${limit} MB.`);
    if (it.kind === "clip" && it.start !== undefined && it.end !== undefined && it.end - it.start < 1) {
      errors.push(`Item ${i + 1}: o trecho do clipe precisa ter pelo menos 1 segundo.`);
    }
  });
  if (d.music.kind === "file" && d.music.file.size > LIMITS_MB.audio * MB) errors.push(`A música passa de ${LIMITS_MB.audio} MB.`);
  if (d.music.kind !== "none" && d.music.end - d.music.start < 3) errors.push("O trecho da música precisa ter pelo menos 3 segundos.");
  if (d.music.kind === "none" && !(d.music.duration > 0)) errors.push("Informe a duração do vídeo.");
  if (d.music.kind !== "none" && (d.fades.fadeIn ?? 0) + (d.fades.fadeOut ?? 0) > d.music.end - d.music.start) {
    errors.push("A entrada e a saída da música somam mais que o trecho escolhido.");
  }
  for (const [role, f] of Object.entries(d.logos)) {
    if (f && f.size > LIMITS_MB.logo * MB) errors.push(`A logo de ${role === "brand" ? "marca" : "parceiro"} passa de ${LIMITS_MB.logo} MB.`);
  }
  const total =
    d.items.reduce((s, i) => s + i.file.size, 0) +
    (d.music.kind === "file" ? d.music.file.size : 0) +
    (d.logos.brand?.size ?? 0) +
    (d.logos.partner?.size ?? 0);
  if (total > LIMITS_MB.total * MB) errors.push(`O envio todo passa de ${LIMITS_MB.total} MB.`);
  return errors;
}

/**
 * Monta o `options` da API e a lista de arquivos (campo → arquivo).
 * A ordem do vídeo é a ordem de `d.items`.
 */
export function buildRequest(d: Draft): { options: Record<string, unknown>; files: [string, File][] } {
  const files: [string, File][] = [];
  const items = d.items.map((it, i) => {
    const field = `item${String(i + 1).padStart(2, "0")}`;
    files.push([field, it.file]);
    const out: Record<string, unknown> = { file: field, type: it.kind };
    if (it.focus) out.focus = { x: round3(it.focus.x), y: round3(it.focus.y) };
    if (it.zoom && it.zoom > 1.001) out.zoom = Math.round(it.zoom * 100) / 100;
    if (it.caption.trim()) out.caption = it.caption.trim();
    if (it.kind === "clip") {
      const whole = it.sourceDuration;
      const start = it.start ?? 0;
      const end = it.end ?? whole;
      if (start > 0) out.start = round3(start);
      if (end !== undefined && (whole === undefined || end < whole - 0.001)) out.end = round3(end);
      if (it.keepAudio) {
        out.keepAudio = true;
        if (it.volume !== 1) out.volume = round3(it.volume);
      }
    }
    return out;
  });
  const options: Record<string, unknown> = { preset: d.preset, platform: d.platform, items };
  if (d.title.trim()) options.title = d.title.trim();
  const m = d.music;
  if (m.kind === "none") {
    options.timing = { mode: "fixed", total: round3(m.duration) };
  } else {
    const audio: Record<string, unknown> = { start: round3(m.start), end: round3(m.end) };
    if (m.loop) audio.loop = true;
    if (m.kind === "file") {
      files.push(["musica", m.file]);
      audio.file = "musica";
    } else {
      audio.libraryId = m.id;
    }
    options.audio = audio;
    const fades: Record<string, number> = {};
    if (d.fades.fadeIn !== undefined) fades.fadeIn = d.fades.fadeIn;
    if (d.fades.fadeOut !== undefined) fades.fadeOut = d.fades.fadeOut;
    if (Object.keys(fades).length) options.overrides = { audio: fades };
  }
  const logos: { role: string; file: string }[] = [];
  if (d.logos.brand) {
    files.push(["logo_marca", d.logos.brand]);
    logos.push({ role: "brand", file: "logo_marca" });
  }
  if (d.logos.partner) {
    files.push(["logo_parceiro", d.logos.partner]);
    logos.push({ role: "partner", file: "logo_parceiro" });
  }
  if (logos.length) options.logos = logos;
  return { options, files };
}

/** Move um item de posição (ordem do vídeo). */
export function moveItem<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return list;
  const copy = list.slice();
  const [it] = copy.splice(from, 1);
  copy.splice(to, 0, it!);
  return copy;
}

const VIDEO_EXT = /\.(mp4|mov|m4v|webm|mkv)$/i;
const IMAGE_EXT = /\.(jpe?g|png|webp)$/i;
const HEIC_EXT = /\.(heic|heif)$/i;

/** Classifica um arquivo escolhido pelo usuário. */
export function classify(file: { name: string; type: string }): ItemKind | "heic" | "unknown" {
  if (file.type === "image/heic" || file.type === "image/heif" || HEIC_EXT.test(file.name)) return "heic";
  if (file.type.startsWith("video/") || VIDEO_EXT.test(file.name)) return "clip";
  if (/^image\/(jpeg|png|webp)$/.test(file.type) || IMAGE_EXT.test(file.name)) return "photo";
  return "unknown";
}

/** Ordena arquivos pelo nome, com números em ordem natural (2 antes de 10). */
export function naturalSort<T extends { name: string }>(files: T[]): T[] {
  const collator = new Intl.Collator("pt-BR", { numeric: true, sensitivity: "base" });
  return files.slice().sort((a, b) => collator.compare(a.name, b.name));
}

/** Descreve onde o preset mostra cada papel de logo. */
export function brandingSlots(branding: unknown): { brand: string[]; partner: string[] } {
  const out = { brand: [] as string[], partner: [] as string[] };
  if (!branding || typeof branding !== "object") return out;
  const names: Record<string, string> = {
    watermark: "marca d'água",
    intro: "cartão de abertura",
    outro: "cartão de encerramento",
    between: "cartões entre os itens",
  };
  for (const [slot, label] of Object.entries(names)) {
    const conf = (branding as Record<string, unknown>)[slot] as { role?: string } | null | undefined;
    if (conf && (conf.role === "brand" || conf.role === "partner")) out[conf.role].push(label);
  }
  return out;
}
