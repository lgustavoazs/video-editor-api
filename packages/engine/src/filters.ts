import { join } from "node:path";
import type { PhotoFilter } from "./preset.js";

/** Formata números para o filtergraph sem notação científica nem zeros sobrando. */
export function n(value: number, digits = 4): string {
  return String(Number(value.toFixed(digits)));
}

/** Escapa um valor (caminho, expressão) para uso entre aspas simples no filtergraph. */
export function quote(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "'\\\\\\''").replace(/:/g, "\\:")}'`;
}

/** "#rrggbb" -> "0xrrggbb" (formato de cor do FFmpeg), com opacidade opcional. */
export function color(hex: string, opacity?: number): string {
  const base = `0x${hex.slice(1).toLowerCase()}`;
  return opacity === undefined ? base : `${base}@${n(opacity, 3)}`;
}

/** Converte o parâmetro temperature (-1 frio .. 1 quente) para Kelvin do filtro colortemperature. */
export function temperatureToKelvin(temperature: number): number {
  // No filtro do FFmpeg, valores abaixo de 6500 K esquentam a imagem e acima esfriam.
  return temperature >= 0 ? 6500 - temperature * 3000 : 6500 + -temperature * 6000;
}

const SEPIA = [
  [0.393, 0.769, 0.189],
  [0.349, 0.686, 0.168],
  [0.272, 0.534, 0.131],
] as const;

export interface FilterContext {
  /** Pasta dos arquivos .cube. */
  lutsDir: string;
}

/** Traduz um filtro do preset para um ou mais filtros do FFmpeg (lista vazia = neutro). */
export function photoFilterToFfmpeg(filter: PhotoFilter, ctx: FilterContext): string[] {
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
    case "curves":
      return [`curves=preset=${filter.preset}`];
    case "grayscale": {
      const amount = filter.amount ?? 1;
      return amount === 0 ? [] : [`hue=s=${n(1 - amount)}`];
    }
    case "sepia": {
      const a = filter.amount ?? 1;
      if (a === 0) return [];
      // mistura linear entre a identidade e a matriz de sépia
      const m = SEPIA.map((row, i) => row.map((v, j) => n(v * a + (i === j ? 1 - a : 0))));
      const [r, g, b] = m as [string[], string[], string[]];
      return [
        `colorchannelmixer=rr=${r[0]}:rg=${r[1]}:rb=${r[2]}:gr=${g[0]}:gg=${g[1]}:gb=${g[2]}:br=${b[0]}:bg=${b[1]}:bb=${b[2]}`,
      ];
    }
    case "lut":
      // o nome do arquivo já foi restrito pelo schema a [a-z0-9-]+.cube
      return [`lut3d=file=${quote(join(ctx.lutsDir, filter.file))}`];
    case "vignette": {
      const strength = filter.strength ?? 0.3;
      // ângulo do filtro vai de 0 a PI/2; limitamos a 80% para não escurecer o centro
      return strength === 0 ? [] : [`vignette=angle=${n(strength * (Math.PI / 2) * 0.8)}`];
    }
    case "grain": {
      const amount = filter.amount ?? 10;
      // ruído só na luminância, variando a cada quadro
      return amount === 0 ? [] : [`noise=c0s=${n(amount, 0)}:c0f=t+u`];
    }
    case "blur": {
      const radius = filter.radius ?? 4;
      return radius === 0 ? [] : [`gblur=sigma=${n(radius)}`];
    }
    case "sharpen": {
      const amount = filter.amount ?? 0.6;
      return amount === 0 ? [] : [`unsharp=lx=5:ly=5:la=${n(amount)}`];
    }
    case "clarity": {
      const amount = filter.amount ?? 0.5;
      // máscara larga: realça o contraste local em vez das bordas finas
      return amount === 0 ? [] : [`unsharp=lx=13:ly=13:la=${n(amount)}`];
    }
  }
}
