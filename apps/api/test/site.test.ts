import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { makeTestAssets, TEST_ASSETS_DIR } from "@video-editor/engine";
import { buildApp, type App } from "../src/app.js";
import { loadConfig, type ApiConfig } from "../src/config.js";
import { issueSession, verifySession } from "../src/session.js";

const ADMIN = "admin-de-teste-site-1234567890";
const PASSWORD = "senha-do-site-123";
let dir: string;
let cfg: ApiConfig;
let api: App;
let cookie: string;
let assets: Awaited<ReturnType<typeof makeTestAssets>>;

before(async () => {
  assets = await makeTestAssets(TEST_ASSETS_DIR);
  dir = await mkdtemp(join(tmpdir(), "api-site-"));
  // Site "compilado" mínimo, para testar o servidor de arquivos.
  const web = join(dir, "web");
  await mkdir(join(web, "assets"), { recursive: true });
  await writeFile(join(web, "index.html"), "<!doctype html><title>site</title>");
  await writeFile(join(web, "assets", "app-abc123.js"), "console.log(1)");
  const audio = join(dir, "audio");
  await mkdir(join(audio, "tracks"), { recursive: true });
  await copyFile(assets.tone, join(audio, "tracks", "tom.wav"));
  await writeFile(join(audio, "library.json"), JSON.stringify({ tracks: [{ id: "tom", name: "Tom", file: "tracks/tom.wav", moods: ["teste"], license: "gerado" }] }));
  cfg = {
    ...loadConfig({}),
    dataDir: join(dir, "data"),
    webDir: web,
    audioDir: audio,
    adminKey: ADMIN,
    sitePassword: PASSWORD,
    cleanupMinutes: 0,
    rateLimitPerMinute: 0,
    createLimitPerMinute: 0,
    selftestWarmup: false,
  };
  api = await buildApp(cfg, { logger: false });
});

after(async () => {
  await api?.close();
  await rm(dir, { recursive: true, force: true });
});

describe("login do site", () => {
  test("estado inicial: habilitado e sem sessão", async () => {
    const res = await api.app.inject({ method: "GET", url: "/v1/session" });
    assert.deepEqual(res.json(), { enabled: true, authenticated: false });
  });

  test("senha errada: 401; sem sessão, as rotas pedem chave", async () => {
    const res = await api.app.inject({ method: "POST", url: "/v1/session", payload: { password: "errada-123" } });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().error.code, "wrong_password");
    const list = await api.app.inject({ method: "GET", url: "/v1/videos" });
    assert.equal(list.statusCode, 401);
  });

  test("senha certa: cookie HttpOnly e SameSite=Strict que vale como chave", async () => {
    const res = await api.app.inject({ method: "POST", url: "/v1/session", payload: { password: PASSWORD } });
    assert.equal(res.statusCode, 204);
    const setCookie = String(res.headers["set-cookie"]);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    assert.doesNotMatch(setCookie, /Secure/, "em http local não marca Secure");
    cookie = setCookie.split(";")[0]!;
    const s = await api.app.inject({ method: "GET", url: "/v1/session", headers: { cookie } });
    assert.equal(s.json().authenticated, true);
    const presets = await api.app.inject({ method: "GET", url: "/v1/presets", headers: { cookie } });
    assert.equal(presets.statusCode, 200);
  });

  test("em https o cookie é Secure", async () => {
    const res = await api.app.inject({
      method: "POST",
      url: "/v1/session",
      payload: { password: PASSWORD },
      headers: { "x-forwarded-proto": "https" },
    });
    assert.match(String(res.headers["set-cookie"]), /Secure/);
  });

  test("a sessão não vale para a administração", async () => {
    const res = await api.app.inject({ method: "GET", url: "/v1/admin/info", headers: { cookie } });
    assert.equal(res.statusCode, 401);
  });

  test("cookie adulterado, vencido ou de outra senha não vale", () => {
    const { token } = issueSession(cfg);
    assert.equal(verifySession(cfg, token), true);
    assert.equal(verifySession(cfg, token.replace(/.$/, (c) => (c === "A" ? "B" : "A"))), false);
    assert.equal(verifySession(cfg, token, Date.now() + 31 * 24 * 3600_000), false);
    assert.equal(verifySession({ ...cfg, sitePassword: "outra-senha-999" }, token), false);
  });

  test("limite de tentativas de login", async () => {
    const ip = { "x-forwarded-for": "203.0.113.9" };
    let last = 0;
    for (let i = 0; i < 6; i++) {
      last = (await api.app.inject({ method: "POST", url: "/v1/session", payload: { password: "x" }, headers: ip })).statusCode;
    }
    assert.equal(last, 429);
  });

  test("sem SITE_PASSWORD o login fica desligado", async () => {
    const off = await buildApp({ ...cfg, dataDir: join(dir, "data-off"), sitePassword: undefined }, { logger: false });
    try {
      assert.deepEqual((await off.app.inject({ method: "GET", url: "/v1/session" })).json(), { enabled: false, authenticated: false });
      assert.equal((await off.app.inject({ method: "POST", url: "/v1/session", payload: { password: PASSWORD } })).statusCode, 404);
      // um cookie válido do outro servidor não vale aqui
      assert.equal((await off.app.inject({ method: "GET", url: "/v1/videos", headers: { cookie } })).statusCode, 401);
    } finally {
      await off.close();
    }
  });
});

describe("vídeos pelo site", () => {
  test("criar com a sessão, listar só os da sessão e baixar", async () => {
    const form = new FormData();
    form.append("options", JSON.stringify({ items: [{ file: "f" }], timing: { total: 3 } }));
    form.append("f", new Blob([await readFile(assets.photos[0]!)]), "f.jpg");
    const r = new Response(form);
    const created = await api.app.inject({
      method: "POST",
      url: "/v1/videos",
      payload: Buffer.from(await r.arrayBuffer()),
      headers: { "content-type": r.headers.get("content-type")!, cookie },
    });
    assert.equal(created.statusCode, 202, created.body);
    const id = created.json().id as string;

    // um vídeo de outra chave não aparece na lista do site
    const keyRes = await api.app.inject({ method: "POST", url: "/v1/admin/keys", headers: { "x-admin-key": ADMIN }, payload: { name: "outro" } });
    const other = keyRes.json().key as string;
    const otherList = await api.app.inject({ method: "GET", url: "/v1/videos", headers: { authorization: `Bearer ${other}` } });
    assert.deepEqual(otherList.json().videos, []);

    for (let i = 0; i < 300; i++) {
      const j = (await api.app.inject({ method: "GET", url: `/v1/videos/${id}`, headers: { cookie } })).json();
      if (j.status === "done" || j.status === "failed") break;
      await new Promise((res) => setTimeout(res, 200));
    }
    const list = await api.app.inject({ method: "GET", url: "/v1/videos", headers: { cookie } });
    const videos = list.json().videos as { id: string; status: string }[];
    assert.equal(videos[0]!.id, id);
    assert.equal(videos[0]!.status, "done");
    const dl = await api.app.inject({ method: "GET", url: `/v1/videos/${id}/download`, headers: { cookie } });
    assert.equal(dl.statusCode, 200);
    assert.equal(dl.headers["content-type"], "video/mp4");
  });

  test("arquivo da música da biblioteca", async () => {
    const res = await api.app.inject({ method: "GET", url: "/v1/audio/tom/file", headers: { cookie } });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["content-type"], "audio/wav");
    assert.equal(res.rawPayload.subarray(0, 4).toString(), "RIFF");
    const missing = await api.app.inject({ method: "GET", url: "/v1/audio/nao-existe/file", headers: { cookie } });
    assert.equal(missing.statusCode, 404);
    const noAuth = await api.app.inject({ method: "GET", url: "/v1/audio/tom/file" });
    assert.equal(noAuth.statusCode, 401);
  });
});

describe("páginas do site", () => {
  test("/ e /app levam a /app/; rotas internas devolvem a página", async () => {
    assert.equal((await api.app.inject({ method: "GET", url: "/" })).headers.location, "/app/");
    assert.equal((await api.app.inject({ method: "GET", url: "/app" })).headers.location, "/app/");
    for (const url of ["/app/", "/app/meus-videos"]) {
      const res = await api.app.inject({ method: "GET", url });
      assert.equal(res.statusCode, 200, url);
      assert.match(res.body, /<title>site<\/title>/);
      assert.match(String(res.headers["content-security-policy"]), /default-src 'self'/);
      assert.equal(res.headers["cache-control"], "no-cache");
    }
  });

  test("arquivos com nome versionado ficam em cache longo", async () => {
    const res = await api.app.inject({ method: "GET", url: "/app/assets/app-abc123.js" });
    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers["cache-control"]), /immutable/);
  });

  test("sem o site compilado, /app não existe e a API continua", async () => {
    const bare = await buildApp({ ...cfg, dataDir: join(dir, "data-bare"), webDir: join(dir, "nao-existe") }, { logger: false });
    try {
      assert.equal((await bare.app.inject({ method: "GET", url: "/app/" })).statusCode, 404);
      assert.equal((await bare.app.inject({ method: "GET", url: "/health" })).statusCode, 200);
    } finally {
      await bare.close();
    }
  });
});

describe("editor de estilos (Fase 3B)", () => {
  async function previewForm(preset: unknown) {
    const form = new FormData();
    form.append("options", JSON.stringify({ preset, items: [{ file: "f" }], timing: { total: 3 } }));
    form.append("f", new Blob([await readFile(assets.photos[0]!)]), "f.jpg");
    const r = new Response(form);
    return { payload: Buffer.from(await r.arrayBuffer()), headers: { "content-type": r.headers.get("content-type")! } };
  }

  test("a sessão do site pede amostra com preset inteiro e acompanha em /v1/previews/:id", async () => {
    const body = await previewForm({ extends: "limpo", id: "rascunho", version: 1, name: "Rascunho", letterbox: 0.1 });
    const res = await api.app.inject({ method: "POST", url: "/v1/previews", payload: body.payload, headers: { ...body.headers, cookie } });
    assert.equal(res.statusCode, 202, res.body);
    const { id, statusUrl } = res.json() as { id: string; statusUrl: string };
    assert.ok(statusUrl.endsWith(`/v1/previews/${id}`));
    let view: { status: string; downloadUrl?: string; result?: { width: number } } = { status: "queued" };
    for (let i = 0; i < 300 && (view.status === "queued" || view.status === "processing"); i++) {
      await new Promise((r) => setTimeout(r, 200));
      view = (await api.app.inject({ method: "GET", url: `/v1/previews/${id}`, headers: { cookie } })).json();
    }
    assert.equal(view.status, "done");
    assert.equal(view.result!.width, 540);
    assert.ok(view.downloadUrl!.endsWith(`/v1/previews/${id}/download`));
    const dl = await api.app.inject({ method: "GET", url: `/v1/previews/${id}/download`, headers: { cookie } });
    assert.equal(dl.statusCode, 200);
    // não aparece em Meus vídeos
    const list = (await api.app.inject({ method: "GET", url: "/v1/videos", headers: { cookie } })).json().videos as { id: string }[];
    assert.ok(!list.some((v) => v.id === id));
    // um vídeo comum não é consultável como pré-visualização
    const notPreview = await api.app.inject({ method: "GET", url: `/v1/previews/${list[0]?.id ?? "00000000-0000-0000-0000-000000000000"}`, headers: { cookie } });
    assert.equal(notPreview.statusCode, 404);
  });

  test("sem sessão nem chave de administrador: 401; a pré-visualização do admin não aparece para o site", async () => {
    const body = await previewForm("limpo");
    const anon = await api.app.inject({ method: "POST", url: "/v1/previews", payload: body.payload, headers: body.headers });
    assert.equal(anon.statusCode, 401);
    const adm = await api.app.inject({ method: "POST", url: "/v1/previews", payload: body.payload, headers: { ...body.headers, "x-admin-key": ADMIN } });
    assert.equal(adm.statusCode, 202, adm.body);
    const id = adm.json().id as string;
    assert.equal((await api.app.inject({ method: "GET", url: `/v1/previews/${id}`, headers: { cookie } })).statusCode, 404);
    assert.equal((await api.app.inject({ method: "GET", url: `/v1/previews/${id}?key=${ADMIN}` })).statusCode, 200);
  });

  test("lista de LUTs", async () => {
    const res = await api.app.inject({ method: "GET", url: "/v1/presets/luts", headers: { cookie } });
    assert.ok((res.json().luts as string[]).includes("cinema-azul-laranja.cube"));
  });

  test("validação de preset: devolve o resolvido ou o motivo em português", async () => {
    const ok = await api.app.inject({
      method: "POST",
      url: "/v1/presets/validate",
      headers: { cookie },
      payload: { extends: "limpo", id: "teste", version: 1, name: "Teste", transition: { types: ["fade", "wipeleft"], duration: 0.5 } },
    });
    assert.equal(ok.statusCode, 200, ok.body);
    const preset = ok.json().preset;
    assert.deepEqual(preset.transition.types, ["fade", "wipeleft"]);
    assert.ok(preset.motion, "herdou o movimento do Limpo");
    const bad = await api.app.inject({
      method: "POST",
      url: "/v1/presets/validate",
      headers: { cookie },
      payload: { extends: "limpo", id: "teste", version: 1, name: "Teste", letterbox: 0.9 },
    });
    assert.equal(bad.statusCode, 422);
    assert.equal(bad.json().error.code, "invalid_preset");
    assert.match(bad.json().error.message, /letterbox/);
    const missing = await api.app.inject({ method: "POST", url: "/v1/presets/validate", headers: { cookie }, payload: { extends: "nao-existe", id: "x", version: 1, name: "X" } });
    assert.equal(missing.statusCode, 422);
  });
});
