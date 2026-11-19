import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { makeTestAssets, TEST_ASSETS_DIR } from "@video-editor/engine";
import { buildApp, type App } from "../src/app.js";
import { AudioLibrary } from "../src/audio.js";
import { loadConfig, type ApiConfig } from "../src/config.js";
import { checkCallbackUrl, signPayload } from "../src/webhook.js";

const ADMIN = "admin-de-teste-2b-1234567890";
let dataDir: string;
let audioDir: string;
let cfg: ApiConfig;
let api: App;
let key: string;
let keyId: string;
let secret: string;
let assets: Awaited<ReturnType<typeof makeTestAssets>>;

// ---- servidor que recebe os webhooks ----
interface Received {
  headers: IncomingMessage["headers"];
  body: string;
}
let hookServer: Server;
let hookUrl: string;
const received: Received[] = [];
/** Respostas na ordem; acabando, responde 200. */
let hookReplies: number[] = [];

async function multipart(form: FormData) {
  const res = new Response(form);
  return { payload: Buffer.from(await res.arrayBuffer()), headers: { "content-type": res.headers.get("content-type")! } };
}

async function post(url: string, options: unknown, files: Record<string, string>, headers: Record<string, string>) {
  const form = new FormData();
  form.append("options", JSON.stringify(options));
  for (const [name, path] of Object.entries(files)) form.append(name, new Blob([await readFile(path)]), name);
  const body = await multipart(form);
  return api.app.inject({ method: "POST", url, payload: body.payload, headers: { ...body.headers, ...headers } });
}

const auth = () => ({ authorization: `Bearer ${key}` });
const admin = { "x-admin-key": ADMIN };

async function waitFor<T>(fn: () => T | undefined, ms = 120_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("tempo esgotado");
}

async function waitJob(id: string) {
  return waitFor(() => {
    const j = api.db.job(id);
    return j && j.status !== "queued" && j.status !== "processing" ? j : undefined;
  });
}

before(async () => {
  assets = await makeTestAssets(TEST_ASSETS_DIR);
  dataDir = await mkdtemp(join(tmpdir(), "api-2b-"));
  audioDir = join(dataDir, "audio");
  await mkdir(join(audioDir, "tracks"), { recursive: true });
  await copyFile(assets.tone, join(audioDir, "tracks", "tom.wav"));
  await copyFile(assets.marker, join(audioDir, "tracks", "marcador.wav"));
  await writeFile(
    join(audioDir, "library.json"),
    JSON.stringify({
      tracks: [
        { id: "tom", name: "Tom de teste", file: "tracks/tom.wav", moods: ["calmo", "teste"], license: "gerado" },
        { id: "marcador", name: "Marcador", file: "tracks/marcador.wav", moods: ["teste"], license: "gerado", attribution: "Teste - Marcador" },
      ],
    }),
  );

  hookServer = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      received.push({ headers: req.headers, body });
      res.statusCode = hookReplies.shift() ?? 200;
      res.end("ok");
    });
  });
  await new Promise<void>((r) => hookServer.listen(0, "127.0.0.1", r));
  hookUrl = `http://127.0.0.1:${(hookServer.address() as AddressInfo).port}/aviso`;

  cfg = {
    ...loadConfig({}),
    dataDir: join(dataDir, "data"),
    audioDir,
    adminKey: ADMIN,
    cleanupMinutes: 0,
    rateLimitPerMinute: 0,
    createLimitPerMinute: 0,
    selftestWarmup: false,
    webhookAllowInsecure: true,
    webhookRetryDelaysMs: [100, 100, 100],
  };
  api = await buildApp(cfg, { logger: false });
  const res = await api.app.inject({ method: "POST", url: "/v1/admin/keys", headers: admin, payload: { name: "2b" } });
  ({ key, id: keyId, webhookSecret: secret } = res.json() as { key: string; id: string; webhookSecret: string });
});

after(async () => {
  await api?.close();
  await new Promise((r) => hookServer?.close(r));
  await rm(dataDir, { recursive: true, force: true });
});

describe("biblioteca de áudio", () => {
  test("lista faixas, durações e climas", async () => {
    const res = await api.app.inject({ method: "GET", url: "/v1/audio", headers: auth() });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.deepEqual(body.moods, ["calmo", "teste"]);
    assert.equal(body.tracks.length, 2);
    assert.ok(body.tracks[0].duration > 1);
  });

  test("por id: usa a faixa e mostra a escolha", async () => {
    const res = await post("/v1/videos", { items: [{ file: "f" }], audio: { libraryId: "tom", duration: 4 } }, { f: assets.photos[0]! }, auth());
    assert.equal(res.statusCode, 202, res.body);
    assert.equal(res.json().audioTrack.id, "tom");
    assert.equal(res.json().audioTrack.seed, undefined);
  });

  test("por clima: a mesma semente escolhe sempre a mesma faixa; sem semente, uma é devolvida", async () => {
    const ids = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const res = await post("/v1/videos", { items: [{ file: "f" }], audio: { mood: "teste", seed: 42, duration: 4 } }, { f: assets.photos[0]! }, auth());
      assert.equal(res.statusCode, 202, res.body);
      ids.add(res.json().audioTrack.id);
      assert.equal(res.json().audioTrack.seed, 42);
    }
    assert.equal(ids.size, 1);
    const free = await post("/v1/videos", { items: [{ file: "f" }], audio: { mood: "calmo", duration: 4 } }, { f: assets.photos[0]! }, auth());
    assert.equal(free.json().audioTrack.id, "tom");
    assert.equal(typeof free.json().audioTrack.seed, "number");
  });

  test("erros: id inexistente, clima sem faixas, semente sem clima", async () => {
    const a = await post("/v1/videos", { items: [{ file: "f" }], audio: { libraryId: "nao-existe" } }, { f: assets.photos[0]! }, auth());
    assert.equal(a.statusCode, 422);
    assert.equal(a.json().error.code, "audio_not_found");
    const b = await post("/v1/videos", { items: [{ file: "f" }], audio: { mood: "triste" } }, { f: assets.photos[0]! }, auth());
    assert.equal(b.statusCode, 422);
    assert.deepEqual(b.json().error.details.moods, ["calmo", "teste"]);
    const c = await post("/v1/videos", { items: [{ file: "f" }], audio: { libraryId: "tom", seed: 1 } }, { f: assets.photos[0]! }, auth());
    assert.equal(c.statusCode, 400);
  });

  test("catálogo quebrado impede o servidor de iniciar", async () => {
    const dir = await mkdtemp(join(tmpdir(), "audio-ruim-"));
    try {
      await writeFile(join(dir, "library.json"), JSON.stringify({ tracks: [{ id: "x", name: "X", file: "tracks/x.mp3", moods: ["a"], license: "l" }] }));
      await assert.rejects(new AudioLibrary(dir).load(), /não encontrado/);
      await writeFile(join(dir, "library.json"), JSON.stringify({ tracks: [{ id: "X maiúsculo" }] }));
      await assert.rejects(new AudioLibrary(dir).load(), /inválido/);
      await writeFile(join(dir, "library.json"), JSON.stringify({ tracks: [{ id: "x", name: "X", file: "../segredo", moods: ["a"], license: "l" }] }));
      await assert.rejects(new AudioLibrary(dir).load(), /inválido/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("catálogo do repositório é válido", async () => {
    await new AudioLibrary(loadConfig({}).audioDir).load();
  });
});

describe("webhook", () => {
  test("assinatura confere com o segredo da chave e nova tentativa após falha", async () => {
    received.length = 0;
    hookReplies = [500];
    const res = await post(
      "/v1/videos",
      { items: [{ file: "f" }, { file: "g" }], timing: { total: 4 }, callbackUrl: hookUrl },
      { f: assets.photos[0]!, g: assets.photos[1]! },
      auth(),
    );
    assert.equal(res.statusCode, 202, res.body);
    const id = res.json().id as string;
    await waitJob(id);
    const job = await waitFor(() => {
      const j = api.db.job(id)!;
      return j.webhook_status === "delivered" || j.webhook_status === "failed" ? j : undefined;
    });
    assert.equal(job.webhook_status, "delivered");
    assert.equal(job.webhook_attempts, 2);
    assert.equal(received.length, 2);

    const last = received[1]!;
    assert.equal(last.headers["x-webhook-event"], "video.done");
    assert.equal(last.headers["x-webhook-attempt"], "2");
    const sig = String(last.headers["x-webhook-signature"]);
    const t = Number(/t=(\d+)/.exec(sig)![1]);
    const expected = createHmac("sha256", secret).update(`${t}.${last.body}`).digest("hex");
    assert.equal(sig, `t=${t},v1=${expected}`);
    assert.equal(signPayload(secret, t, last.body), sig);
    const payload = JSON.parse(last.body);
    assert.equal(payload.id, id);
    assert.equal(payload.event, "video.done");
    assert.ok(payload.downloadUrl.endsWith(`/v1/videos/${id}/download`));

    const view = await api.app.inject({ method: "GET", url: `/v1/videos/${id}`, headers: auth() });
    assert.equal(view.json().webhook.status, "delivered");
  });

  test("desiste depois de 3 novas tentativas", async () => {
    received.length = 0;
    hookReplies = [500, 500, 500, 500];
    const res = await post("/v1/videos", { items: [{ file: "f" }], timing: { total: 3 }, callbackUrl: hookUrl }, { f: assets.photos[0]! }, auth());
    const id = res.json().id as string;
    await waitJob(id);
    const job = await waitFor(() => (api.db.job(id)!.webhook_status === "failed" ? api.db.job(id) : undefined));
    assert.equal(job!.webhook_attempts, 4);
    assert.match(job!.webhook_last_error!, /500/);
    assert.equal(received.length, 4);
  });

  test("chave sem segredo não pode pedir webhook; o admin gera um novo", async () => {
    api.db.sql.prepare("UPDATE api_keys SET webhook_secret = NULL WHERE id = ?").run(keyId);
    const res = await post("/v1/videos", { items: [{ file: "f" }], timing: { total: 3 }, callbackUrl: hookUrl }, { f: assets.photos[0]! }, auth());
    assert.equal(res.statusCode, 422);
    assert.equal(res.json().error.code, "webhook_secret_missing");
    const gen = await api.app.inject({ method: "POST", url: `/v1/admin/keys/${keyId}/webhook-secret`, headers: admin });
    assert.equal(gen.statusCode, 200);
    secret = gen.json().webhookSecret;
    assert.match(secret, /^whsec_/);
    const ok = await post("/v1/videos", { items: [{ file: "f" }], timing: { total: 3 }, callbackUrl: hookUrl }, { f: assets.photos[0]! }, auth());
    assert.equal(ok.statusCode, 202, ok.body);
  });

  test("endereços internos e sem https são recusados em produção", async () => {
    const prod = { ...cfg, webhookAllowInsecure: false };
    await assert.rejects(checkCallbackUrl("http://exemplo.com/x", prod), /https/);
    await assert.rejects(checkCallbackUrl("https://127.0.0.1/x", prod), /interno/);
    await assert.rejects(checkCallbackUrl("https://[::1]/x", prod), /interno/);
    await assert.rejects(checkCallbackUrl("https://10.1.2.3/x", prod), /interno/);
    await assert.rejects(checkCallbackUrl("https://169.254.169.254/latest", prod), /interno/);
    await assert.rejects(checkCallbackUrl("https://usuario:senha@8.8.8.8/x", prod), /senha/);
    await checkCallbackUrl("https://8.8.8.8/x", prod);
  });
});

describe("pré-visualização", () => {
  test("só para o admin", async () => {
    const res = await post("/v1/previews", { items: [{ file: "f" }], timing: { total: 3 } }, { f: assets.photos[0]! }, auth());
    assert.equal(res.statusCode, 401);
  });

  test("preset inteiro (com extends), metade da resolução", async () => {
    const preset = { extends: "limpo", id: "rascunho", version: 1, name: "Rascunho", transition: { type: "circleopen", duration: 0.5 } };
    const res = await post(
      "/v1/previews",
      { preset, platform: "tiktok", items: [{ file: "f" }, { file: "c", duration: 2 }], timing: { total: 6 } },
      { f: assets.photos[0]!, c: assets.clips.landscape },
      admin,
    );
    assert.equal(res.statusCode, 202, res.body);
    const job = await waitJob(res.json().id);
    assert.equal(job.status, "done", job.error_json ?? "");
    assert.equal(job.kind, "preview");
    const result = JSON.parse(job.result_json!);
    assert.equal(result.width, 540);
    assert.equal(result.height, 960);
    assert.deepEqual([...new Set(result.transitions)], ["circleopen"]);
    const dl = await api.app.inject({ method: "GET", url: `/v1/admin/jobs/${job.id}/download?key=${ADMIN}` });
    assert.equal(dl.statusCode, 200);
  });

  test("limites: mais de 10 s, mais de 6 itens e preset inválido", async () => {
    const long = await post("/v1/previews", { items: [{ file: "f" }, { file: "g" }], timing: { total: 15 } }, { f: assets.photos[0]!, g: assets.photos[1]! }, admin);
    assert.equal(long.statusCode, 422);
    assert.equal(long.json().error.code, "preview_too_long");
    const many = await post("/v1/previews", { items: Array.from({ length: 7 }, () => ({ file: "f" })) }, { f: assets.photos[0]! }, admin);
    assert.equal(many.statusCode, 400);
    const bad = await post("/v1/previews", { preset: { extends: "limpo", id: "x", version: 1, name: "X", audio: { volume: 99 } }, items: [{ file: "f" }], timing: { total: 3 } }, { f: assets.photos[0]! }, admin);
    assert.equal(bad.statusCode, 422);
    assert.equal(bad.json().error.code, "invalid_preset");
  });

  test("passa na frente dos vídeos na fila", async () => {
    // um vídeo longo ocupa o render; outro fica aguardando
    const busy = await post("/v1/videos", { items: Array.from({ length: 6 }, (_, i) => ({ file: `f${i}` })), timing: { total: 20 } },
      Object.fromEntries(assets.photos.map((p, i) => [`f${i}`, p])), auth());
    const waiting = await post("/v1/videos", { items: [{ file: "f" }], timing: { total: 3 } }, { f: assets.photos[0]! }, auth());
    assert.equal(busy.statusCode, 202, busy.body);
    await waitFor(() => (api.db.job(busy.json().id)!.status === "processing" ? true : undefined));
    const preview = await post("/v1/previews", { items: [{ file: "f" }], timing: { total: 3 } }, { f: assets.photos[0]! }, admin);
    assert.equal(api.queue.position(preview.json().id), 1);
    assert.equal(api.queue.position(waiting.json().id), 2);
    const p = await waitJob(preview.json().id);
    const w = await waitJob(waiting.json().id);
    assert.ok(p.started_at! <= w.started_at!, "a pré-visualização começa antes do vídeo que já aguardava");
  });
});

describe("documentação", () => {
  test("pública em /docs e /openapi.json", async () => {
    const spec = await api.app.inject({ method: "GET", url: "/openapi.json" });
    assert.equal(spec.statusCode, 200);
    const doc = spec.json();
    assert.equal(doc.openapi, "3.1.0");
    for (const path of ["/v1/videos", "/v1/previews", "/v1/audio", "/v1/admin/keys/{id}/webhook-secret"]) {
      assert.ok(doc.paths[path], `falta ${path}`);
    }
    const ui = await api.app.inject({ method: "GET", url: "/docs" });
    assert.equal(ui.statusCode, 200);
    assert.match(ui.body, /<!DOCTYPE html>/i);
  });

  test("todas as rotas registradas estão documentadas", async () => {
    const doc = (await api.app.inject({ method: "GET", url: "/openapi.json" })).json() as {
      paths: Record<string, Record<string, unknown>>;
    };
    const routes = api.routes.filter((r) => r.url.startsWith("/v1/") || r.url === "/health");
    assert.ok(routes.length >= 15, `poucas rotas encontradas: ${routes.length}`);
    for (const r of routes) {
      const path = r.url.replace(/:(\w+)/g, "{$1}");
      assert.ok(doc.paths[path]?.[r.method.toLowerCase()], `rota sem documentação: ${r.method} ${r.url}`);
    }
  });
});
