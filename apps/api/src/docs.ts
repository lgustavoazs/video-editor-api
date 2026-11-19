import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import type { FastifyInstance } from "fastify";
import { optionsSchema, previewOptionsSchema } from "./options.js";

const clone = <T>(v: T): T => structuredClone(v);

const errorResponse = {
  description: "Erro (formato único para todos os erros)",
  content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
};
const errors = (...codes: number[]) => Object.fromEntries(codes.map((c) => [String(c), errorResponse]));

const multipartBody = (optionsRef: string, description: string) => ({
  required: true,
  description,
  content: {
    "multipart/form-data": {
      schema: {
        type: "object",
        required: ["options"],
        properties: {
          options: { type: "string", description: `JSON no formato de ${optionsRef.split("/").pop()}` },
        },
        additionalProperties: { type: "string", format: "binary", description: "Arquivos, citados em options pelo nome do campo" },
      },
      encoding: { options: { contentType: "application/json" } },
    },
  },
});

const accepted = (statusPath: string) => ({
  "202": {
    description: "Pedido aceito e na fila",
    content: {
      "application/json": {
        schema: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            status: { const: "queued" },
            queuePosition: { type: ["integer", "null"] },
            estimatedDuration: { type: "number", description: "Duração prevista do vídeo, em segundos" },
            itemCount: { type: "integer" },
            audioTrack: { $ref: "#/components/schemas/AudioTrackChoice" },
            warnings: { type: "array", items: { type: "string" } },
            statusUrl: { type: "string", description: `Consulta do estado (${statusPath})` },
          },
        },
      },
    },
  },
});

/** Especificação OpenAPI 3.1, escrita à mão para refletir exatamente o comportamento da API. */
export function openApiDocument(version: string) {
  return {
    openapi: "3.1.0",
    info: {
      title: "Video Editor API",
      version,
      description: [
        "Gera vídeos curtos para redes sociais a partir de fotos, clipes, música e logos, com estilos fixos (presets), sem IA.",
        "",
        "**Fluxo:** `POST /v1/videos` (multipart) → consultar `GET /v1/videos/{id}` até `done` (ou receber o webhook) → baixar em `downloadUrl`.",
        "",
        "**Arquivos:** vão em campos do multipart e são citados em `options` pelo nome do campo. O tipo é identificado pelo conteúdo: imagem vira foto, vídeo vira clipe.",
        "",
        "**Ordem:** o vídeo segue a ordem da lista `options.items`, item a item. O nome dos arquivos e a ordem dos campos no multipart não influem. Para mudar a ordem, mude a posição na lista.",
        "**Logos** vão em `options.logos` (papéis `brand` e `partner`), nunca em `items`: uma logo colocada em `items` aparece como uma foto comum.",
        "Limites: foto 15 MB, clipe 200 MB, áudio 20 MB, logo 5 MB, pedido 500 MB; até 30 itens (10 clipes). Fotos HEIC não são aceitas (envie JPEG ou PNG).",
        "",
        "**Webhook:** com `callbackUrl`, o servidor envia um POST quando o vídeo fica pronto (`video.done`) ou falha (`video.failed`), com até 3 novas tentativas (após 10 s, 1 min e 5 min).",
        "O header `X-Webhook-Signature: t=<unix>,v1=<hex>` traz o HMAC-SHA256 de `\"<t>.<corpo>\"` com o segredo `whsec_...` da sua chave. Confira a assinatura e recuse `t` com mais de 5 minutos.",
        "",
        "**Erros:** `{\"error\": {\"code\", \"message\", \"details\"}}`. Regras (fotos demais, trecho fora do áudio...) voltam como 422 na criação, antes da fila.",
        "",
        "Os vídeos ficam disponíveis por 24 h.",
      ].join("\n"),
    },
    servers: [{ url: "/" }],
    components: {
      securitySchemes: {
        apiKey: { type: "http", scheme: "bearer", description: "Chave do cliente (`vea_...`). Também aceita no header `X-API-Key`." },
        adminKey: { type: "apiKey", in: "header", name: "X-Admin-Key", description: "Chave de administrador (também `?key=` nas rotas GET)." },
      },
      schemas: {
        Error: {
          type: "object",
          required: ["error"],
          properties: {
            error: {
              type: "object",
              required: ["code", "message"],
              properties: {
                code: { type: "string", examples: ["too_many_photos"] },
                message: { type: "string" },
                details: { type: "object" },
              },
            },
          },
        },
        VideoOptions: clone(optionsSchema),
        PreviewOptions: clone(previewOptionsSchema),
        AudioTrackChoice: {
          type: ["object", "null"],
          description: "Música escolhida da biblioteca (com `seed` quando sorteada por clima, para repetir o sorteio)",
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            seed: { type: "integer" },
            attribution: { type: ["string", "null"] },
          },
        },
        Job: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            status: { enum: ["queued", "processing", "done", "failed", "expired", "canceled", "deleted"] },
            progress: { type: "number", description: "0 a 100" },
            queuePosition: { type: ["integer", "null"] },
            createdAt: { type: "string", format: "date-time" },
            startedAt: { type: ["string", "null"], format: "date-time" },
            finishedAt: { type: ["string", "null"], format: "date-time" },
            expiresAt: { type: ["string", "null"], format: "date-time" },
            warnings: { type: "array", items: { type: "string" } },
            error: { type: ["object", "null"], properties: { code: { type: "string" }, message: { type: "string" } } },
            audioTrack: { $ref: "#/components/schemas/AudioTrackChoice" },
            result: {
              type: "object",
              properties: {
                duration: { type: "number" },
                width: { type: "integer" },
                height: { type: "integer" },
                fps: { type: "number" },
                itemCount: { type: "integer" },
                transitions: { type: "array", items: { type: "string" } },
              },
            },
            sizeBytes: { type: ["integer", "null"] },
            downloadUrl: { type: "string" },
            webhook: {
              type: "object",
              properties: {
                url: { type: "string" },
                status: { enum: ["waiting", "pending", "delivered", "failed"] },
                attempts: { type: "integer" },
                lastError: { type: ["string", "null"] },
              },
            },
          },
        },
        WebhookPayload: {
          type: "object",
          properties: {
            event: { enum: ["video.done", "video.failed"] },
            id: { type: "string", format: "uuid" },
            status: { type: "string" },
            createdAt: { type: "string", format: "date-time" },
            finishedAt: { type: ["string", "null"] },
            expiresAt: { type: ["string", "null"] },
            duration: { type: ["number", "null"] },
            sizeBytes: { type: ["integer", "null"] },
            downloadUrl: { type: ["string", "null"] },
            warnings: { type: "array", items: { type: "string" } },
            error: { type: ["object", "null"] },
          },
        },
      },
    },
    paths: {
      "/v1/videos": {
        get: {
          tags: ["Vídeos"],
          summary: "Vídeos recentes da chave (enquanto não expiram), do mais novo ao mais antigo",
          security: [{ apiKey: [] }],
          responses: {
            "200": {
              description: "Lista",
              content: {
                "application/json": {
                  schema: { type: "object", properties: { videos: { type: "array", items: { $ref: "#/components/schemas/Job" } } } },
                },
              },
            },
            ...errors(401),
          },
        },
        post: {
          tags: ["Vídeos"],
          summary: "Criar um vídeo",
          security: [{ apiKey: [] }],
          requestBody: multipartBody("#/components/schemas/VideoOptions", "Campo `options` (JSON, ver VideoOptions) e os arquivos"),
          responses: { ...accepted("/v1/videos/{id}"), ...errors(400, 401, 413, 415, 422, 429, 503) },
        },
      },
      "/v1/videos/{id}": {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        get: {
          tags: ["Vídeos"],
          summary: "Estado e progresso",
          security: [{ apiKey: [] }],
          responses: {
            "200": { description: "Estado do pedido", content: { "application/json": { schema: { $ref: "#/components/schemas/Job" } } } },
            ...errors(401, 404),
          },
        },
        delete: {
          tags: ["Vídeos"],
          summary: "Cancelar (na fila) ou apagar (pronto)",
          security: [{ apiKey: [] }],
          responses: { "204": { description: "Feito" }, ...errors(401, 404, 409) },
        },
      },
      "/v1/videos/{id}/download": {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        get: {
          tags: ["Vídeos"],
          summary: "Baixar o MP4 (aceita Range)",
          security: [{ apiKey: [] }],
          responses: {
            "200": { description: "Vídeo", content: { "video/mp4": { schema: { type: "string", format: "binary" } } } },
            "206": { description: "Parte do vídeo (Range)" },
            ...errors(401, 404, 409, 410),
          },
        },
      },
      "/v1/presets": {
        get: { tags: ["Catálogo"], summary: "Presets disponíveis", security: [{ apiKey: [] }], responses: { "200": { description: "Lista" }, ...errors(401) } },
      },
      "/v1/presets/schema": {
        get: { tags: ["Catálogo"], summary: "JSON Schema dos presets", security: [{ apiKey: [] }], responses: { "200": { description: "JSON Schema" }, ...errors(401) } },
      },
      "/v1/presets/{id}": {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        get: { tags: ["Catálogo"], summary: "Um preset completo", security: [{ apiKey: [] }], responses: { "200": { description: "Preset" }, ...errors(401, 404) } },
      },
      "/v1/platforms": {
        get: {
          tags: ["Catálogo"],
          summary: "Perfis de plataforma (tamanho, duração máxima, zona segura)",
          security: [{ apiKey: [] }],
          responses: { "200": { description: "Lista" }, ...errors(401) },
        },
      },
      "/v1/audio": {
        get: {
          tags: ["Catálogo"],
          summary: "Biblioteca de músicas (use em options.audio.libraryId ou options.audio.mood)",
          security: [{ apiKey: [] }],
          responses: { "200": { description: "Faixas e climas disponíveis" }, ...errors(401) },
        },
      },
      "/v1/audio/{id}/file": {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        get: {
          tags: ["Catálogo"],
          summary: "Arquivo de uma música da biblioteca (para ouvir ou desenhar a forma de onda)",
          security: [{ apiKey: [] }],
          responses: { "200": { description: "Áudio", content: { "audio/*": { schema: { type: "string", format: "binary" } } } }, ...errors(401, 404) },
        },
      },
      "/v1/previews": {
        post: {
          tags: ["Administração"],
          summary: "Pré-visualização curta (até 6 itens, 10 s, metade da resolução), com prioridade na fila",
          description: "O preset pode ser um id ou o preset inteiro (como o editor exporta). Consulte em /v1/admin/jobs/{id}.",
          security: [{ adminKey: [] }],
          requestBody: multipartBody("#/components/schemas/PreviewOptions", "Campo `options` (JSON, ver PreviewOptions) e os arquivos"),
          responses: { ...accepted("/v1/admin/jobs/{id}"), ...errors(400, 401, 413, 415, 422, 503) },
        },
      },
      "/v1/admin/keys": {
        get: { tags: ["Administração"], summary: "Listar chaves", security: [{ adminKey: [] }], responses: { "200": { description: "Lista (sem os valores)" } } },
        post: {
          tags: ["Administração"],
          summary: "Criar chave de cliente (devolve a chave e o segredo do webhook uma única vez)",
          security: [{ adminKey: [] }],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { type: "object", required: ["name"], properties: { name: { type: "string", maxLength: 80 } } } } },
          },
          responses: { "201": { description: "Chave criada" }, ...errors(400, 401) },
        },
      },
      "/v1/admin/keys/{id}": {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        delete: { tags: ["Administração"], summary: "Revogar chave", security: [{ adminKey: [] }], responses: { "204": { description: "Revogada" }, ...errors(401, 404) } },
      },
      "/v1/admin/keys/{id}/webhook-secret": {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        post: {
          tags: ["Administração"],
          summary: "Gerar ou trocar o segredo do webhook da chave",
          security: [{ adminKey: [] }],
          responses: { "200": { description: "Novo segredo (exibido uma vez)" }, ...errors(401, 404) },
        },
      },
      "/v1/admin/info": {
        get: { tags: ["Administração"], summary: "Diagnóstico do servidor", security: [{ adminKey: [] }], responses: { "200": { description: "FFmpeg, CPUs, disco, fila" } } },
      },
      "/v1/admin/selftest": {
        get: {
          tags: ["Administração"],
          summary: "Gerar um vídeo com arquivos de teste, sem upload",
          security: [{ adminKey: [] }],
          parameters: [
            { name: "photos", in: "query", schema: { type: "integer", minimum: 0, maximum: 30, default: 8 } },
            { name: "clips", in: "query", schema: { type: "integer", minimum: 0, maximum: 3, default: 0 } },
            { name: "duration", in: "query", schema: { type: "number", minimum: 3, maximum: 180, default: 20 } },
            { name: "preset", in: "query", schema: { type: "string" } },
          ],
          responses: accepted("/v1/admin/jobs/{id}"),
        },
      },
      "/v1/admin/jobs/{id}": {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        get: { tags: ["Administração"], summary: "Qualquer pedido, com as medições do render", security: [{ adminKey: [] }], responses: { "200": { description: "Pedido" } } },
      },
      "/v1/admin/jobs/{id}/download": {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        get: { tags: ["Administração"], summary: "Baixar qualquer vídeo (inclusive pré-visualizações)", security: [{ adminKey: [] }], responses: { "200": { description: "Vídeo" } } },
      },
      "/v1/session": {
        get: {
          tags: ["Site"],
          summary: "Estado do login do site (usado pela página em /app)",
          responses: {
            "200": {
              description: "enabled: login configurado; authenticated: há sessão válida",
              content: { "application/json": { schema: { type: "object", properties: { enabled: { type: "boolean" }, authenticated: { type: "boolean" } } } } },
            },
          },
        },
        post: {
          tags: ["Site"],
          summary: "Entrar no site com a senha (cria um cookie de sessão por 30 dias)",
          description: "A sessão vale como chave da API para as rotas de vídeos, presets, plataformas e áudio, só a partir do próprio site. Até 5 tentativas por minuto.",
          requestBody: {
            required: true,
            content: { "application/json": { schema: { type: "object", required: ["password"], properties: { password: { type: "string" } } } } },
          },
          responses: { "204": { description: "Sessão criada (cookie)" }, ...errors(401, 404, 429) },
        },
        delete: { tags: ["Site"], summary: "Sair do site", responses: { "204": { description: "Sessão encerrada" } } },
      },
      "/health": {
        get: { tags: ["Serviço"], summary: "Verificação de saúde (pública)", responses: { "200": { description: "OK" } } },
      },
    },
    webhooks: {
      "video.done": {
        post: {
          summary: "Vídeo pronto ou com falha (event video.done ou video.failed)",
          requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/WebhookPayload" } } } },
          responses: { "200": { description: "Qualquer resposta 2xx confirma o recebimento" } },
        },
      },
    },
  };
}

/** Publica a documentação em /docs (pública, sem chave) e a especificação em /openapi.json. */
export async function registerDocs(app: FastifyInstance, version = "2B"): Promise<void> {
  const document = openApiDocument(version);
  await app.register(swagger, { mode: "static", specification: { document: document as never } });
  await app.register(swaggerUi, { routePrefix: "/docs", uiConfig: { docExpansion: "list", deepLinking: true } });
  app.get("/openapi.json", { schema: { hide: true } }, async () => document);
}
