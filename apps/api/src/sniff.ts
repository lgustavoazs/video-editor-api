import { open } from "node:fs/promises";

export type MediaKind = "image" | "video" | "audio" | "heic" | "unknown";

export interface Sniffed {
  kind: MediaKind;
  /** Formato detectado (jpeg, png, mp4, mp3...). */
  format: string;
}

/** Lê os primeiros bytes de um arquivo. */
export async function readHead(file: string, length = 64): Promise<Buffer> {
  const fh = await open(file, "r");
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

const HEIF_BRANDS = new Set(["heic", "heix", "heim", "heis", "hevc", "hevx", "mif1", "msf1", "avif", "avis"]);
const AUDIO_BRANDS = new Set(["M4A ", "M4B ", "M4P ", "F4A "]);

/**
 * Identifica o tipo pelo conteúdo (assinatura no início do arquivo), não pelo nome
 * nem pelo Content-Type enviado, que podem estar errados.
 */
export function sniff(head: Buffer): Sniffed {
  const ascii = (start: number, end: number) => head.subarray(start, end).toString("latin1");
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return { kind: "image", format: "jpeg" };
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { kind: "image", format: "png" };
  }
  if (head.length >= 12 && ascii(0, 4) === "RIFF") {
    const sub = ascii(8, 12);
    if (sub === "WEBP") return { kind: "image", format: "webp" };
    if (sub === "WAVE") return { kind: "audio", format: "wav" };
    if (sub === "AVI ") return { kind: "video", format: "avi" };
  }
  if (head.length >= 12 && ascii(4, 8) === "ftyp") {
    const brand = ascii(8, 12);
    if (HEIF_BRANDS.has(brand)) return { kind: "heic", format: brand.trim() };
    if (AUDIO_BRANDS.has(brand)) return { kind: "audio", format: "m4a" };
    if (brand === "qt  ") return { kind: "video", format: "mov" };
    return { kind: "video", format: "mp4" };
  }
  if (head.length >= 4 && head.readUInt32BE(0) === 0x1a45dfa3) return { kind: "video", format: "mkv/webm" };
  if (head.length >= 3 && ascii(0, 3) === "ID3") return { kind: "audio", format: "mp3" };
  if (head.length >= 4 && ascii(0, 4) === "OggS") return { kind: "audio", format: "ogg" };
  if (head.length >= 4 && ascii(0, 4) === "fLaC") return { kind: "audio", format: "flac" };
  if (head.length >= 2 && head[0] === 0xff && (head[1]! & 0xe0) === 0xe0) {
    // Quadro MPEG (mp3 sem ID3) ou AAC em ADTS.
    const layer = (head[1]! >> 1) & 0x03;
    return { kind: "audio", format: layer === 0 ? "aac" : "mp3" };
  }
  return { kind: "unknown", format: "unknown" };
}
