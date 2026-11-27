/**
 * Funções puras do editor de estilos (testadas em test/editor.test.ts).
 * O schema vem da API (/v1/presets/schema): é a mesma fonte de faixas que o motor usa.
 */

// O schema é JSON genérico; tipá-lo inteiro não traria segurança real aqui.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = any;
export type Preset = Record<string, Json>;

/** Blocos editáveis do preset, na ordem em que aparecem na tela. */
export const BLOCKS = ["photo", "motion", "transition", "timing", "letterbox", "audio", "text", "branding"] as const;

/** Nomes dos grupos na tela (o schema tem títulos, mas alguns ficam melhores assim). */
export const BLOCK_TITLES: Record<string, string> = {
  photo: "Foto e clipe: enquadramento e filtros",
  motion: "Movimento",
  transition: "Transições",
  timing: "Ritmo",
  letterbox: "Barras de cinema",
  audio: "Música",
  text: "Título e legendas",
  branding: "Logos",
};

/** Textos em português para os valores fixos do schema. */
export const ENUM_LABELS: Record<string, string> = {
  cover: "Cortar para preencher",
  contain: "Mostrar inteira (com fundo)",
  auto: "Automático (pelo formato)",
  blur: "Desfocado",
  color: "Cor sólida",
  kenburns: "Zoom lento (Ken Burns)",
  none: "Nenhum",
  in: "Aproximando",
  out: "Afastando",
  alternate: "Alternado",
  left: "Para a esquerda",
  right: "Para a direita",
  up: "Para cima",
  down: "Para baixo",
  cycle: "Rodízio",
  random: "Sorteio (semente fixa)",
  top: "Em cima",
  center: "No centro",
  bottom: "Embaixo",
  "top-left": "Canto superior esquerdo",
  "top-center": "Em cima, no centro",
  "top-right": "Canto superior direito",
  "bottom-left": "Canto inferior esquerdo",
  "bottom-center": "Embaixo, no centro",
  "bottom-right": "Canto inferior direito",
  brand: "Marca",
  partner: "Parceiro",
  sans: "Normal",
  "sans-bold": "Negrito",
  vintage: "Vintage",
  cross_process: "Processo cruzado",
  darker: "Mais escuro",
  lighter: "Mais claro",
  increase_contrast: "Mais contraste",
  linear_contrast: "Contraste linear",
  medium_contrast: "Contraste médio",
  strong_contrast: "Contraste forte",
  negative: "Negativo",
  color_negative: "Negativo colorido",
};

export const label = (v: string) => ENUM_LABELS[v] ?? v;

/** Tipos de campo que o formulário sabe desenhar. */
export type FieldKind = "number" | "integer" | "enum" | "color" | "boolean" | "string" | "object" | "array" | "unknown";

export function isNullable(node: Json): boolean {
  return Array.isArray(node?.type) && node.type.includes("null");
}

export function fieldKind(node: Json): FieldKind {
  if (!node) return "unknown";
  const t = Array.isArray(node.type) ? node.type.find((x: string) => x !== "null") : node.type;
  if (node.enum) return "enum";
  if (t === "string" && node.pattern === "^#[0-9a-fA-F]{6}$") return "color";
  if (t === "number") return "number";
  if (t === "integer") return "integer";
  if (t === "boolean") return "boolean";
  if (t === "string") return "string";
  if (t === "object") return "object";
  if (t === "array") return "array";
  return "unknown";
}

/** Objeto com os valores padrão de um nó do schema (para ligar um bloco opcional). */
export function defaultsFor(node: Json): Record<string, Json> {
  const out: Record<string, Json> = {};
  for (const [key, child] of Object.entries<Json>(node?.properties ?? {})) {
    if (child.default !== undefined && child.default !== null) out[key] = structuredClone(child.default);
    else if (child.const !== undefined) out[key] = child.const;
  }
  // Campos obrigatórios sem padrão (ex.: papel da logo) recebem o primeiro valor possível.
  for (const key of node?.required ?? []) {
    if (out[key] === undefined && node.properties?.[key]?.enum) out[key] = node.properties[key].enum[0];
  }
  return out;
}

/** Esquemas de cada filtro (um por tipo), na ordem do schema. */
export function filterSchemas(schema: Json): Json[] {
  return schema?.properties?.photo?.properties?.filters?.items?.oneOf ?? [];
}

/** Filtro novo do tipo pedido, com os valores padrão. */
export function newFilter(schema: Json, type: string, luts: string[] = []): Record<string, Json> {
  const node = filterSchemas(schema).find((f) => f.properties?.type?.const === type);
  const f: Record<string, Json> = { type, ...defaultsFor(node) };
  if (type === "curves" && !f.preset) f.preset = "vintage";
  if (type === "lut" && !f.file && luts[0]) f.file = luts[0];
  return f;
}

/** JSON com as chaves em ordem, para comparar objetos. */
export function canonical(v: Json): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

/**
 * Preset para exportar: herda do estilo base e traz só os blocos diferentes dele.
 * Assim o arquivo fica curto e acompanha melhorias futuras do estilo base.
 */
export function exportPreset(current: Preset, base: Preset, baseId: string): Preset {
  const out: Preset = {
    id: current.id,
    version: current.version ?? 1,
    name: current.name,
  };
  if (current.description) out.description = current.description;
  if (current.id !== baseId) out.extends = baseId;
  for (const key of BLOCKS) {
    const same = canonical(current[key]) === canonical(base[key]);
    if (current.id === baseId || !same) out[key] = current[key] === undefined ? null : structuredClone(current[key]);
  }
  return out;
}

/** Id válido para um estilo novo (minúsculas, números e hífen). */
export function slugify(name: string): string {
  return (
    name
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "novo-estilo"
  );
}

/** Lê o valor num caminho ("text.title.size"). */
export function getAt(obj: Json, path: string[]): Json {
  return path.reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/** Cópia do objeto com o valor trocado no caminho (cria os níveis que faltarem). */
export function setAt<T extends Json>(obj: T, path: string[], value: Json): T {
  if (path.length === 0) return value;
  const [head, ...rest] = path as [string, ...string[]];
  const copy: Json = Array.isArray(obj) ? [...obj] : { ...(obj ?? {}) };
  if (rest.length === 0) {
    if (value === undefined) delete copy[head];
    else copy[head] = value;
  } else {
    copy[head] = setAt(copy[head], rest, value);
  }
  return copy;
}

// ---------------- prévia aproximada ----------------

/** Filtros que o navegador não consegue imitar com fidelidade: só aparecem na amostra real. */
export const SAMPLE_ONLY = new Set(["curves", "lut", "sharpen", "clarity"]);

export interface ApproxLook {
  /** Valor para a propriedade CSS `filter`. */
  css: string;
  /** Cor e opacidade de uma camada para a temperatura (quente = laranja, frio = azul). */
  tint: { color: string; opacity: number } | null;
  vignette: number;
  grain: number;
  /** Filtros presentes que não entram na prévia. */
  sampleOnly: string[];
}

/** Traduz a lista de filtros do preset para uma aparência aproximada no navegador. */
export function approxLook(filters: Json[] = []): ApproxLook {
  const css: string[] = [];
  let tint: ApproxLook["tint"] = null;
  let vignette = 0;
  let grain = 0;
  const sampleOnly: string[] = [];
  for (const f of filters) {
    switch (f.type) {
      case "color": {
        if (f.brightness) css.push(`brightness(${(1 + f.brightness).toFixed(3)})`);
        if (f.contrast !== undefined && f.contrast !== 1) css.push(`contrast(${f.contrast})`);
        if (f.saturation !== undefined && f.saturation !== 1) css.push(`saturate(${f.saturation})`);
        if (f.temperature) {
          tint = {
            color: f.temperature > 0 ? "rgb(255,140,40)" : "rgb(60,120,255)",
            opacity: Math.min(0.45, Math.abs(f.temperature) * 0.45),
          };
        }
        break;
      }
      case "grayscale":
        css.push(`grayscale(${f.amount ?? 1})`);
        break;
      case "sepia":
        css.push(`sepia(${f.amount ?? 1})`);
        break;
      case "blur":
        // O raio do motor é em pixels do vídeo; a prévia é cerca de 4 vezes menor.
        css.push(`blur(${((f.radius ?? 0) / 4).toFixed(2)}px)`);
        break;
      case "vignette":
        vignette = Math.max(vignette, f.strength ?? 0);
        break;
      case "grain":
        grain = Math.max(grain, f.amount ?? 0);
        break;
      default:
        if (SAMPLE_ONLY.has(f.type)) sampleOnly.push(f.type);
    }
  }
  return { css: css.join(" "), tint, vignette, grain, sampleOnly };
}

/** Duração média de cada foto na prévia, dentro das faixas do ritmo. */
export function previewPhotoSeconds(timing: Json): number {
  const min = timing?.perPhotoMin ?? 1.5;
  const max = timing?.perPhotoMax ?? 6;
  return Math.min(max, Math.max(min, 2.5));
}
