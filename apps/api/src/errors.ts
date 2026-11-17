import { EngineError } from "@video-editor/engine";

/** Erro da API com status HTTP e código estável (o mesmo formato para todos os erros). */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Erros do motor que indicam problema do servidor, não do pedido. */
const SERVER_CODES = new Set([
  "ffmpeg_not_found",
  "ffmpeg_unsupported",
  "render_failed",
  "render_timeout",
  "invalid_threads",
  "lut_not_found",
  "transition_unsupported",
]);

export function engineStatus(err: EngineError): number {
  return SERVER_CODES.has(err.code) ? 500 : 422;
}

export interface ErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

export function errorBody(code: string, message: string, details?: Record<string, unknown>): ErrorBody {
  return { error: { code, message, ...(details && Object.keys(details).length ? { details } : {}) } };
}

/** Converte qualquer erro em status + corpo. Erros inesperados não vazam detalhes internos. */
export function toHttpError(err: unknown): { status: number; body: ErrorBody } {
  if (err instanceof ApiError) return { status: err.status, body: errorBody(err.code, err.message, err.details) };
  if (err instanceof EngineError) {
    const status = engineStatus(err);
    return { status, body: errorBody(err.code, err.message, status < 500 ? err.details : undefined) };
  }
  const e = err as { statusCode?: number; code?: string; message?: string; validation?: unknown };
  if (e && typeof e.statusCode === "number" && e.statusCode < 500) {
    return { status: e.statusCode, body: errorBody(fastifyCode(e.code, e.statusCode), translate(e)) };
  }
  return { status: 500, body: errorBody("internal_error", "Erro interno. Tente novamente mais tarde.") };
}

function fastifyCode(code: string | undefined, status: number): string {
  if (code === "FST_REQ_FILE_TOO_LARGE" || code === "FST_FILES_LIMIT" || code === "FST_PARTS_LIMIT") return "upload_too_large";
  if (code === "FST_ERR_CTP_INVALID_MEDIA_TYPE") return "unsupported_media_type";
  if (code === "FST_ERR_CTP_BODY_TOO_LARGE") return "upload_too_large";
  if (code === "FST_ERR_CTP_EMPTY_JSON_BODY" || code === "FST_ERR_CTP_INVALID_JSON_BODY") return "invalid_json";
  if (status === 404) return "not_found";
  return "bad_request";
}

function translate(e: { code?: string; message?: string }): string {
  switch (e.code) {
    case "FST_REQ_FILE_TOO_LARGE":
      return "Arquivo maior que o limite permitido";
    case "FST_FILES_LIMIT":
    case "FST_PARTS_LIMIT":
      return "Arquivos demais no pedido";
    case "FST_ERR_CTP_INVALID_MEDIA_TYPE":
      return "Tipo de conteúdo não suportado";
    case "FST_ERR_CTP_BODY_TOO_LARGE":
      return "Pedido maior que o limite permitido";
    case "FST_ERR_CTP_EMPTY_JSON_BODY":
    case "FST_ERR_CTP_INVALID_JSON_BODY":
      return "JSON inválido no corpo do pedido";
    default:
      return e.message ?? "Pedido inválido";
  }
}
