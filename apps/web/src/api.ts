/** Cliente da API. O site usa a sessão (cookie) no lugar de chave: mesmo endereço, sem CORS. */

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

async function parseError(res: Response | { status: number; text: string }): Promise<ApiError> {
  const text = res instanceof Response ? await res.text() : res.text;
  try {
    const body = JSON.parse(text) as { error?: { code: string; message: string; details?: Record<string, unknown> } };
    if (body.error) return new ApiError(res.status, body.error.code, body.error.message, body.error.details);
  } catch {
    // resposta sem JSON (ex.: proxy da Railway)
  }
  return new ApiError(res.status, "http_error", `Erro ${res.status} do servidor. Tente de novo.`);
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "network", "Sem conexão com o servidor. Confira a internet e tente de novo.");
  }
  if (!res.ok) throw await parseError(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export interface PresetSummary {
  id: string;
  name: string;
  description?: string;
}
export interface Platform {
  id: string;
  width: number;
  height: number;
  fps: number;
  maxDuration: number;
}
export interface Track {
  id: string;
  name: string;
  moods: string[];
  duration: number;
  license: string;
  attribution: string | null;
}
export interface Job {
  id: string;
  status: "queued" | "processing" | "done" | "failed" | "expired" | "canceled" | "deleted";
  progress: number;
  queuePosition: number | null;
  createdAt: string;
  finishedAt: string | null;
  expiresAt: string | null;
  warnings: string[];
  error: { code: string; message: string } | null;
  result?: { duration: number; width: number; height: number };
  sizeBytes?: number | null;
  downloadUrl?: string;
  audioTrack?: { id: string; name: string } | null;
}
export interface Created {
  id: string;
  estimatedDuration: number;
  warnings: string[];
}

export const api = {
  session: () => request<{ enabled: boolean; authenticated: boolean }>("GET", "/v1/session"),
  login: (password: string) => request<void>("POST", "/v1/session", { password }),
  logout: () => request<void>("DELETE", "/v1/session"),
  presets: () => request<{ presets: PresetSummary[] }>("GET", "/v1/presets").then((r) => r.presets),
  preset: (id: string) => request<Record<string, unknown>>("GET", `/v1/presets/${encodeURIComponent(id)}`),
  platforms: () => request<{ platforms: Platform[] }>("GET", "/v1/platforms").then((r) => r.platforms),
  audio: () => request<{ tracks: Track[]; moods: string[] }>("GET", "/v1/audio"),
  audioFileUrl: (id: string) => `/v1/audio/${encodeURIComponent(id)}/file`,
  video: (id: string) => request<Job>("GET", `/v1/videos/${id}`),
  videos: () => request<{ videos: Job[] }>("GET", "/v1/videos").then((r) => r.videos),
  deleteVideo: (id: string) => request<void>("DELETE", `/v1/videos/${id}`),
  downloadUrl: (id: string) => `/v1/videos/${id}/download`,

  /**
   * Envia o pedido com progresso do upload (fetch ainda não informa o progresso do envio).
   * `onUpload` recebe de 0 a 1.
   */
  createVideo(form: FormData, onUpload: (fraction: number) => void): { promise: Promise<Created>; abort: () => void } {
    const xhr = new XMLHttpRequest();
    const promise = new Promise<Created>((resolve, reject) => {
      xhr.open("POST", "/v1/videos");
      xhr.withCredentials = true;
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onUpload(e.loaded / e.total);
      };
      xhr.onload = async () => {
        if (xhr.status === 202) {
          resolve(JSON.parse(xhr.responseText) as Created);
        } else {
          reject(await parseError({ status: xhr.status, text: xhr.responseText }));
        }
      };
      xhr.onerror = () => reject(new ApiError(0, "network", "A conexão caiu durante o envio. Tente de novo."));
      xhr.onabort = () => reject(new ApiError(0, "aborted", "Envio cancelado."));
      xhr.send(form);
    });
    return { promise, abort: () => xhr.abort() };
  },
};
