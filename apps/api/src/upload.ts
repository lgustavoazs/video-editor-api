import { createWriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { FastifyRequest } from "fastify";
import type { ApiConfig } from "./config.js";
import { ApiError } from "./errors.js";
import { readHead, sniff, type Sniffed } from "./sniff.js";

export interface UploadedFile {
  field: string;
  path: string;
  size: number;
  /** Nome original, só para mensagens. */
  filename: string;
  sniffed: Sniffed;
}

export interface Upload {
  /** Texto JSON, ou o objeto já convertido (quando o campo vem com Content-Type application/json). */
  options?: string | object;
  files: Map<string, UploadedFile>;
}

const MB = 1024 * 1024;

/**
 * Recebe o multipart gravando cada arquivo direto no disco (sem guardar em memória).
 * O tipo é identificado pelo conteúdo depois de gravado.
 */
export async function receiveUpload(req: FastifyRequest, cfg: ApiConfig, dir: string): Promise<Upload> {
  if (!req.isMultipart()) {
    throw new ApiError(415, "unsupported_media_type", "Envie o pedido como multipart/form-data");
  }
  await mkdir(dir, { recursive: true });
  const maxFile = Math.max(cfg.limits.photo, cfg.limits.clip, cfg.limits.audio, cfg.limits.logo);
  const files = new Map<string, UploadedFile>();
  let options: string | object | undefined;
  let total = 0;
  let index = 0;

  const parts = req.parts({
    limits: { fileSize: maxFile, files: cfg.limits.files, fields: 5, fieldSize: MB, parts: cfg.limits.files + 5 },
  });
  for await (const part of parts) {
    if (part.type === "field") {
      if (part.fieldname !== "options") {
        throw new ApiError(400, "unknown_field", `Campo de texto desconhecido: "${part.fieldname}" (só "options" é aceito)`);
      }
      // Com Content-Type application/json no campo, o multipart já entrega o objeto pronto.
      const value: unknown = part.value;
      if (typeof value === "string" || (typeof value === "object" && value !== null && !Array.isArray(value))) {
        options = value;
      } else {
        throw new ApiError(400, "invalid_options", '"options" deve ser um objeto JSON');
      }
      continue;
    }
    const field = part.fieldname;
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(field)) {
      part.file.resume();
      throw new ApiError(400, "invalid_field", `Nome de campo de arquivo inválido: "${field.slice(0, 64)}" (use letras, números, _ . -)`);
    }
    if (files.has(field)) {
      part.file.resume();
      throw new ApiError(400, "duplicate_field", `O campo "${field}" foi enviado mais de uma vez`);
    }
    const path = join(dir, `${String(index++).padStart(2, "0")}-${field}`);
    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        total += chunk.length;
        if (total > cfg.limits.total) {
          cb(new ApiError(413, "upload_too_large", `O pedido passa de ${Math.round(cfg.limits.total / MB)} MB no total`));
          return;
        }
        cb(null, chunk);
      },
    });
    await pipeline(part.file, counter, createWriteStream(path));
    if (part.file.truncated) {
      throw new ApiError(413, "upload_too_large", `"${field}" passa do limite de ${Math.round(maxFile / MB)} MB`);
    }
    const size = (await stat(path)).size;
    if (size === 0) throw new ApiError(400, "empty_file", `O arquivo "${field}" está vazio`);
    files.set(field, { field, path, size, filename: part.filename ?? field, sniffed: sniff(await readHead(path)) });
  }
  return { options, files };
}

/** Confere tipo e tamanho de um arquivo para o uso pedido. */
export function checkFile(
  cfg: ApiConfig,
  file: UploadedFile,
  use: "photo" | "clip" | "audio" | "logo",
  where: string,
): void {
  const { kind, format } = file.sniffed;
  if (kind === "heic") {
    throw new ApiError(
      415,
      "unsupported_format",
      `${where}: fotos HEIC/HEIF (padrão do iPhone) ainda não são aceitas. Envie JPEG ou PNG (no iPhone: Ajustes > Câmera > Formatos > Mais Compatível).`,
      { field: file.field },
    );
  }
  const accepted: Record<typeof use, string[]> = {
    photo: ["image"],
    logo: ["image"],
    clip: ["video"],
    // Vídeo também serve como fonte de áudio (o FFmpeg usa só a faixa de som).
    audio: ["audio", "video"],
  };
  if (!accepted[use].includes(kind)) {
    const expected = { photo: "imagem JPEG, PNG ou WebP", logo: "imagem PNG, JPEG ou WebP", clip: "vídeo MP4, MOV ou WebM", audio: "áudio MP3, WAV, M4A, OGG ou FLAC" }[use];
    throw new ApiError(415, "unsupported_format", `${where}: esperado ${expected}, recebido ${kind === "unknown" ? "formato desconhecido" : format}`, {
      field: file.field,
    });
  }
  const limit = cfg.limits[use];
  if (file.size > limit) {
    throw new ApiError(413, "upload_too_large", `${where}: ${(file.size / MB).toFixed(1)} MB passa do limite de ${Math.round(limit / MB)} MB`, {
      field: file.field,
    });
  }
}

export async function discard(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}
