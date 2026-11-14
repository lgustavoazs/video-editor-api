import { join } from "node:path";
import { color, n, quote } from "./filters.js";
import type { TextStyle } from "./preset.js";

export const MAX_TITLE_LENGTH = 80;
export const MAX_CAPTION_LENGTH = 120;

const FONT_FILES = { sans: "DejaVuSans.ttf", "sans-bold": "DejaVuSans-Bold.ttf" } as const;

/** Largura média de um caractere em relação ao tamanho da fonte (DejaVu Sans). */
const CHAR_WIDTH_RATIO = 0.6;

/** Remove caracteres de controle e espaços repetidos. */
export function cleanText(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
}

/** Quebra o texto em linhas de até maxChars, sem partir palavras (exceto as maiores que a linha). */
export function wrapText(text: string, maxChars: number): string[] {
  const limit = Math.max(4, Math.floor(maxChars));
  const lines: string[] = [];
  let current = "";
  for (let word of cleanText(text).split(" ")) {
    while (word.length > limit) {
      if (current) {
        lines.push(current);
        current = "";
      }
      lines.push(word.slice(0, limit));
      word = word.slice(limit);
    }
    if (!current) current = word;
    else if (current.length + 1 + word.length <= limit) current += ` ${word}`;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

export interface TextLayout {
  frameWidth: number;
  frameHeight: number;
  /** Margens (em pixels) a manter livres no topo, embaixo e nas laterais. */
  marginTop: number;
  marginBottom: number;
  marginSide: number;
}

export function fontSizePx(style: Pick<TextStyle, "size">, frameHeight: number): number {
  return Math.max(12, Math.round(style.size * frameHeight));
}

/** Quantos caracteres cabem por linha dentro das margens. */
export function charsPerLine(style: Pick<TextStyle, "size">, layout: TextLayout): number {
  const usable = layout.frameWidth - 2 * layout.marginSide;
  return usable / (fontSizePx(style, layout.frameHeight) * CHAR_WIDTH_RATIO);
}

export interface DrawTextOptions {
  style: TextStyle;
  layout: TextLayout;
  /** Arquivo com o texto já quebrado em linhas (evita escapar o conteúdo no filtergraph). */
  textFile: string;
  fontsDir: string;
  /** Janela de exibição e fade, em segundos. Sem ela, o texto fica o tempo todo. */
  window?: { start: number; end: number; fade: number };
  /** Posição vertical fixa (pixels a partir do topo), em vez da posição do estilo. */
  fixedY?: number;
}

export function drawText(opts: DrawTextOptions): string {
  const { style, layout } = opts;
  const size = fontSizePx(style, layout.frameHeight);
  const y =
    opts.fixedY !== undefined
      ? n(opts.fixedY, 0)
      : style.position === "top"
        ? n(layout.marginTop, 0)
        : style.position === "center"
          ? "(h-text_h)/2"
          : `h-text_h-${n(layout.marginBottom, 0)}`;

  const parts = [
    `fontfile=${quote(join(opts.fontsDir, FONT_FILES[style.font]))}`,
    `textfile=${quote(opts.textFile)}`,
    `fontsize=${size}`,
    `fontcolor=${color(style.color)}`,
    `line_spacing=${Math.round(size * 0.25)}`,
    "x=(w-text_w)/2",
    `y=${y}`,
  ];
  if (style.box) {
    parts.push("box=1", `boxcolor=${color(style.boxColor, style.boxOpacity)}`, `boxborderw=${Math.round(size * 0.4)}`);
  }
  if (opts.window) {
    const { start, end, fade } = opts.window;
    parts.push(`enable=${quote(`between(t,${n(start)},${n(end)})`)}`);
    if (fade > 0) {
      const f = n(fade);
      parts.push(
        `alpha=${quote(`min(1,max(0,min((t-${n(start)})/${f},(${n(end)}-t)/${f})))`)}`,
      );
    }
  }
  return `drawtext=${parts.join(":")}`;
}
