import sharp, { type Sharp } from "sharp";
import { EngineError } from "./errors.js";
import type { Preset } from "./preset.js";

const MAX_INPUT_PIXELS = 8000 * 8000;

export interface Focus {
  /** 0 (esquerda) a 1 (direita) */
  x: number;
  /** 0 (topo) a 1 (base) */
  y: number;
}

export interface PreparedPhoto {
  fit: "cover" | "contain";
  /** Ponto de interesse dentro do quadro já enquadrado (centro do zoom). */
  focus: Focus;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  return {
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Dimensões da imagem já com a rotação EXIF aplicada. */
async function orientedSize(input: string): Promise<{ width: number; height: number }> {
  const meta = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
  if (!meta.width || !meta.height) throw new Error("dimensões desconhecidas");
  const swap = (meta.orientation ?? 1) >= 5;
  return swap ? { width: meta.height, height: meta.width } : { width: meta.width, height: meta.height };
}

/** Fração da foto que o corte "cover" removeria para caber no quadro. */
export function coverLoss(imageW: number, imageH: number, frameW: number, frameH: number): number {
  const image = imageW / imageH;
  const frame = frameW / frameH;
  return 1 - Math.min(image / frame, frame / image);
}

/** Decide o enquadramento efetivo de uma foto. */
export function resolveFit(
  photo: Preset["photo"],
  loss: number,
  hasFocus: boolean,
): "cover" | "contain" {
  if (photo.fit !== "auto") return photo.fit;
  // Um ponto de interesse informado indica que o app quer o corte, deslocado para ele.
  if (hasFocus) return "cover";
  return loss > photo.autoThreshold ? "contain" : "cover";
}

/**
 * Normaliza uma foto para o tamanho do quadro: corrige a rotação (EXIF), converte para sRGB
 * e enquadra. O quadro vem ampliado (supersample), o que evita tremor no zoom do Ken Burns.
 */
export async function preparePhoto(
  input: string,
  output: string,
  frameW: number,
  frameH: number,
  photo: Preset["photo"],
  focus?: Focus,
): Promise<PreparedPhoto> {
  try {
    const size = await orientedSize(input);
    const fit = resolveFit(photo, coverLoss(size.width, size.height, frameW, frameH), focus !== undefined);
    const open = () => sharp(input, { failOn: "error", limitInputPixels: MAX_INPUT_PIXELS }).rotate();
    const jpeg = { quality: 92, chromaSubsampling: "4:4:4" } as const;

    if (fit === "cover") {
      const scale = Math.max(frameW / size.width, frameH / size.height);
      const scaledW = Math.max(frameW, Math.round(size.width * scale));
      const scaledH = Math.max(frameH, Math.round(size.height * scale));
      const fx = focus?.x ?? 0.5;
      const fy = focus?.y ?? 0.5;
      const left = clamp(Math.round(fx * scaledW - frameW / 2), 0, scaledW - frameW);
      const top = clamp(Math.round(fy * scaledH - frameH / 2), 0, scaledH - frameH);
      await open()
        .resize(scaledW, scaledH, { fit: "fill" })
        .extract({ left, top, width: frameW, height: frameH })
        .toColourspace("srgb")
        .jpeg(jpeg)
        .toFile(output);
      return {
        fit,
        focus: {
          x: clamp((fx * scaledW - left) / frameW, 0, 1),
          y: clamp((fy * scaledH - top) / frameH, 0, 1),
        },
      };
    }

    // contain: a foto inteira sobre um fundo (ela mesma desfocada, ou uma cor)
    const foreground = await open().resize(frameW, frameH, { fit: "inside" }).toColourspace("srgb").png().toBuffer();
    let background: Sharp;
    if (photo.background.type === "color") {
      background = sharp({
        create: { width: frameW, height: frameH, channels: 3, background: hexToRgb(photo.background.color) },
      });
    } else {
      // desfoca em resolução reduzida (bem mais rápido) e amplia de volta
      const smallW = Math.max(16, Math.round(frameW / 8));
      const smallH = Math.max(16, Math.round(frameH / 8));
      let small = open().resize(smallW, smallH, { fit: "cover" }).toColourspace("srgb");
      const sigma = (photo.background.blur / 8) * (frameW / 1080);
      if (sigma >= 0.3) small = small.blur(sigma);
      if (photo.background.darken > 0) small = small.modulate({ brightness: 1 - photo.background.darken });
      background = sharp(await small.png().toBuffer()).resize(frameW, frameH, { fit: "fill", kernel: "cubic" });
    }
    await sharp(await background.png().toBuffer())
      .composite([{ input: foreground, gravity: "centre" }])
      .jpeg(jpeg)
      .toFile(output);
    return { fit, focus: { x: 0.5, y: 0.5 } };
  } catch (err) {
    if (err instanceof EngineError) throw err;
    throw new EngineError("unreadable_photo", `Não foi possível ler a foto: ${input}`, {
      cause: (err as Error).message,
    });
  }
}

/** Abre uma logo (PNG, JPG, WebP ou SVG) e devolve um PNG com a largura pedida. */
async function logoBuffer(input: string, width: number): Promise<{ data: Buffer; width: number; height: number }> {
  try {
    const { data, info } = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS, density: 300 })
      .rotate()
      .resize({ width, withoutEnlargement: false })
      .ensureAlpha()
      .toColourspace("srgb")
      .png()
      .toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height };
  } catch (err) {
    throw new EngineError("unreadable_logo", `Não foi possível ler a logo: ${input}`, {
      cause: (err as Error).message,
    });
  }
}

/** Gera o PNG da marca d'água. Devolve o tamanho final em pixels. */
export async function prepareWatermark(
  input: string,
  output: string,
  width: number,
  maxHeight: number,
): Promise<{ width: number; height: number }> {
  let logo = await logoBuffer(input, width);
  if (logo.height > maxHeight) {
    logo = await logoBuffer(input, Math.max(8, Math.round((width * maxHeight) / logo.height)));
  }
  await sharp(logo.data).toFile(output);
  return { width: logo.width, height: logo.height };
}

/**
 * Gera um cartão de logo: fundo de cor sólida com a logo centralizada.
 * Devolve a posição vertical (pixels) logo abaixo da logo, onde entra o texto opcional.
 */
export async function prepareCard(
  logoFile: string,
  output: string,
  frameW: number,
  frameH: number,
  background: string,
  logoWidthFraction: number,
  hasCaption: boolean,
): Promise<{ captionY: number }> {
  let logo = await logoBuffer(logoFile, Math.round(frameW * logoWidthFraction));
  const maxHeight = Math.round(frameH * 0.5);
  if (logo.height > maxHeight) {
    logo = await logoBuffer(logoFile, Math.max(8, Math.round((logo.width * maxHeight) / logo.height)));
  }
  const left = Math.round((frameW - logo.width) / 2);
  // com texto, a logo sobe um pouco para o conjunto ficar centrado
  const top = Math.round((frameH - logo.height) / 2 - (hasCaption ? frameH * 0.03 : 0));
  await sharp({ create: { width: frameW, height: frameH, channels: 3, background: hexToRgb(background) } })
    .composite([{ input: logo.data, left, top }])
    .jpeg({ quality: 95, chromaSubsampling: "4:4:4" })
    .toFile(output);
  return { captionY: top + logo.height + Math.round(frameH * 0.03) };
}
