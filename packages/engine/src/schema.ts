import { ALL_TRANSITIONS } from "./transitions.js";

const HEX_COLOR = { type: "string", pattern: "^#[0-9a-fA-F]{6}$" } as const;
const ROLE = { type: "string", enum: ["brand", "partner"] } as const;

const textStyle = {
  font: { type: "string", enum: ["sans", "sans-bold"], default: "sans-bold", title: "Fonte" },
  size: {
    type: "number", minimum: 0.015, maximum: 0.15, default: 0.04,
    title: "Tamanho", description: "Fração da altura do quadro",
  },
  color: { ...HEX_COLOR, default: "#ffffff", title: "Cor" },
  position: { type: "string", enum: ["top", "center", "bottom"], default: "bottom", title: "Posição" },
  box: { type: "boolean", default: true, title: "Fundo atrás do texto" },
  boxColor: { ...HEX_COLOR, default: "#000000", title: "Cor do fundo" },
  boxOpacity: { type: "number", minimum: 0, maximum: 1, default: 0.5, title: "Opacidade do fundo" },
} as const;

const card = (extra: Record<string, unknown> = {}) => ({
  type: ["object", "null"],
  additionalProperties: false,
  required: ["role"],
  properties: {
    role: { ...ROLE, title: "Logo usada" },
    duration: { type: "number", minimum: 0.8, maximum: 10, default: 2, title: "Duração (s)" },
    background: { ...HEX_COLOR, default: "#000000", title: "Cor de fundo" },
    width: {
      type: "number", minimum: 0.1, maximum: 0.9, default: 0.5,
      title: "Largura da logo", description: "Fração da largura do quadro",
    },
    caption: { type: "string", maxLength: 60, title: "Texto abaixo da logo" },
    captionColor: { ...HEX_COLOR, default: "#ffffff", title: "Cor do texto" },
    ...extra,
  },
});

const filter = (type: string, title: string, properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  title,
  additionalProperties: false,
  required: ["type", ...required],
  properties: { type: { const: type }, ...properties },
});

/**
 * JSON Schema dos presets. É a fonte única das faixas válidas:
 * valida os arquivos de presets/ e alimenta o editor visual.
 */
export const presetSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "https://video-editor-api/preset.schema.json",
  title: "Preset de estilo",
  type: "object",
  additionalProperties: false,
  required: ["id", "version", "name", "photo", "motion", "transition", "timing"],
  properties: {
    id: { type: "string", pattern: "^[a-z0-9-]+$", maxLength: 40 },
    version: { type: "integer", minimum: 1 },
    name: { type: "string", minLength: 1, maxLength: 60 },
    description: { type: "string", maxLength: 300 },
    extends: { type: "string", pattern: "^[a-z0-9-]+$" },

    photo: {
      type: "object",
      title: "Foto",
      additionalProperties: false,
      properties: {
        fit: {
          type: "string", enum: ["cover", "contain", "auto"], default: "auto", title: "Enquadramento",
          description:
            "cover corta para preencher; contain mostra a foto inteira sobre um fundo; auto escolhe pelo formato da foto",
        },
        autoThreshold: {
          type: "number", minimum: 0, maximum: 1, default: 0.5, title: "Limite do modo auto",
          description: "Se o corte removeria mais que esta fração da foto, usa contain",
        },
        background: {
          type: "object",
          title: "Fundo do modo contain",
          additionalProperties: false,
          default: {},
          properties: {
            type: { type: "string", enum: ["blur", "color"], default: "blur" },
            blur: { type: "number", minimum: 0, maximum: 100, default: 40, title: "Desfoque" },
            darken: { type: "number", minimum: 0, maximum: 0.9, default: 0.35, title: "Escurecimento" },
            color: { ...HEX_COLOR, default: "#000000" },
          },
        },
        filters: {
          type: "array",
          title: "Filtros",
          default: [],
          maxItems: 12,
          items: {
            type: "object",
            required: ["type"],
            discriminator: { propertyName: "type" },
            oneOf: [
              filter("color", "Cor", {
                brightness: { type: "number", minimum: -1, maximum: 1, default: 0, title: "Brilho" },
                contrast: { type: "number", minimum: 0, maximum: 2, default: 1, title: "Contraste" },
                saturation: { type: "number", minimum: 0, maximum: 3, default: 1, title: "Saturação" },
                temperature: {
                  type: "number", minimum: -1, maximum: 1, default: 0, title: "Temperatura",
                  description: "Negativo esfria, positivo esquenta",
                },
              }),
              filter("curves", "Curvas", {
                preset: {
                  type: "string",
                  enum: [
                    "vintage", "cross_process", "darker", "lighter", "increase_contrast",
                    "linear_contrast", "medium_contrast", "strong_contrast", "negative", "color_negative",
                  ],
                },
              }, ["preset"]),
              filter("grayscale", "Preto e branco", {
                amount: { type: "number", minimum: 0, maximum: 1, default: 1, title: "Intensidade" },
              }),
              filter("sepia", "Sépia", {
                amount: { type: "number", minimum: 0, maximum: 1, default: 1, title: "Intensidade" },
              }),
              filter("lut", "LUT (.cube)", {
                file: { type: "string", pattern: "^[a-z0-9-]+\\.cube$", title: "Arquivo em presets/luts" },
              }, ["file"]),
              filter("vignette", "Vinheta", {
                strength: { type: "number", minimum: 0, maximum: 1, default: 0.3, title: "Força" },
              }),
              filter("grain", "Grão de filme", {
                amount: { type: "number", minimum: 0, maximum: 100, default: 10, title: "Quantidade" },
              }),
              filter("blur", "Desfoque", {
                radius: { type: "number", minimum: 0, maximum: 50, default: 4, title: "Raio" },
              }),
              filter("sharpen", "Nitidez", {
                amount: { type: "number", minimum: 0, maximum: 2, default: 0.6, title: "Quantidade" },
              }),
              filter("clarity", "Clareza (contraste local)", {
                amount: { type: "number", minimum: 0, maximum: 2, default: 0.5, title: "Quantidade" },
              }),
            ],
          },
        },
      },
    },

    motion: {
      type: "object",
      title: "Movimento",
      additionalProperties: false,
      required: ["type"],
      properties: {
        type: { type: "string", enum: ["kenburns", "none"] },
        zoomFrom: { type: "number", minimum: 1, maximum: 3, default: 1, title: "Zoom inicial" },
        zoomTo: { type: "number", minimum: 1, maximum: 3, default: 1.12, title: "Zoom final" },
        direction: {
          type: "string", enum: ["in", "out", "alternate"], default: "alternate", title: "Direção do zoom",
        },
        pan: {
          type: "string", enum: ["none", "left", "right", "up", "down", "alternate"], default: "none",
          title: "Deslocamento", description: "Só tem efeito quando o zoom é maior que 1",
        },
      },
    },

    transition: {
      type: "object",
      title: "Transição",
      additionalProperties: false,
      required: ["duration"],
      anyOf: [{ required: ["type"] }, { required: ["types"] }],
      properties: {
        type: { type: "string", enum: ALL_TRANSITIONS, title: "Tipo (único)" },
        types: {
          type: "array", minItems: 1, maxItems: 20, title: "Tipos (lista)",
          items: { type: "string", enum: ALL_TRANSITIONS },
        },
        order: {
          type: "string", enum: ["cycle", "random"], default: "cycle", title: "Ordem da lista",
          description: "cycle percorre em rodízio; random sorteia com semente fixa",
        },
        seed: { type: "integer", minimum: 0, maximum: 4294967295, default: 1, title: "Semente do sorteio" },
        duration: { type: "number", minimum: 0, maximum: 3, title: "Duração (s)" },
      },
    },

    timing: {
      type: "object",
      title: "Ritmo",
      additionalProperties: false,
      required: ["perPhotoMin", "perPhotoMax"],
      properties: {
        perPhotoMin: { type: "number", minimum: 0.2, maximum: 60, title: "Mínimo por foto (s)" },
        perPhotoMax: { type: "number", minimum: 0.2, maximum: 60, title: "Máximo por foto (s)" },
      },
    },

    audio: {
      type: "object",
      title: "Áudio",
      additionalProperties: false,
      default: {},
      properties: {
        fadeIn: { type: "number", minimum: 0, maximum: 10, default: 0.5, title: "Fade de entrada (s)" },
        fadeOut: { type: "number", minimum: 0, maximum: 10, default: 1.5, title: "Fade de saída (s)" },
        volume: { type: "number", minimum: 0, maximum: 2, default: 1, title: "Volume" },
      },
    },

    letterbox: {
      type: "number", minimum: 0, maximum: 0.25, default: 0, title: "Barras de cinema",
      description: "Altura de cada barra, como fração da altura do quadro",
    },

    text: {
      type: ["object", "null"],
      title: "Texto",
      additionalProperties: false,
      default: null,
      properties: {
        title: {
          type: ["object", "null"],
          title: "Título",
          additionalProperties: false,
          default: null,
          properties: {
            ...textStyle,
            position: { ...textStyle.position, default: "top" },
            size: { ...textStyle.size, default: 0.05 },
            start: { type: "number", minimum: 0, maximum: 60, default: 0.3, title: "Início (s)" },
            duration: { type: "number", minimum: 0.5, maximum: 60, default: 3.5, title: "Duração (s)" },
            fade: { type: "number", minimum: 0, maximum: 3, default: 0.4, title: "Fade (s)" },
          },
        },
        caption: {
          type: ["object", "null"],
          title: "Legenda por item",
          additionalProperties: false,
          default: null,
          properties: { ...textStyle },
        },
      },
    },

    branding: {
      type: ["object", "null"],
      title: "Logos",
      additionalProperties: false,
      default: null,
      properties: {
        watermark: {
          type: ["object", "null"],
          title: "Marca d'água",
          additionalProperties: false,
          default: null,
          required: ["role"],
          properties: {
            role: { ...ROLE, title: "Logo usada" },
            position: {
              type: "string",
              enum: ["top-left", "top-center", "top-right", "bottom-left", "bottom-center", "bottom-right"],
              default: "top-right",
              title: "Posição",
            },
            width: {
              type: "number", minimum: 0.04, maximum: 0.6, default: 0.16,
              title: "Largura", description: "Fração da largura do quadro",
            },
            opacity: { type: "number", minimum: 0.05, maximum: 1, default: 0.9, title: "Opacidade" },
            margin: {
              type: "number", minimum: 0, maximum: 0.2, default: 0.02,
              title: "Margem extra", description: "Somada à zona segura da plataforma",
            },
          },
        },
        intro: { ...card(), title: "Cartão de abertura", default: null },
        outro: { ...card(), title: "Cartão de encerramento", default: null },
        between: {
          ...card({
            every: {
              type: "integer", minimum: 1, maximum: 30, default: 3,
              title: "A cada quantos itens",
            },
          }),
          title: "Cartão entre itens",
          default: null,
        },
      },
    },
  },
} as const;
