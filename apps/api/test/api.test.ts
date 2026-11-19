import assert from "node:assert/strict";
import { readFile, mkdtemp, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { makeTestAssets, TEST_ASSETS_DIR } from "@video-editor/engine";
import { buildApp, type App } from "../src/app.js";
import { loadConfig, type ApiConfig } from "../src/config.js";

const ADMIN = "admin-de-teste-1234567890";
let dataDir: string;
let cfg: ApiConfig;
let api: App;
let key: string;
let assets: Awaited<ReturnType<typeof makeTestAssets>>;

type Inject = Awaited<ReturnType<App["app"]["inject"]>>;

async function multipart(form: FormData): Promise<{ payload: Buffer; headers: Record<string, string> }> {
  const res = new Response(form);
  return {
    payload: Buffer.from(await res.arrayBuffer()),
    headers: { "content-type": res.headers.get("content-type")! },
  };
}

async function fileBlob(path: string): Promise<Blob> {
  return new Blob([await readFile(path)]);
}

async function postVideo(options: unknown, files: Record<string, Blob | string>, auth = key): Promise<Inject> {
  const form = new FormData();
  if (options !== undefined) form.append("options", typeof options === "string" ? options : JSON.stringify(options));
  for (const [name, value] of Object.entries(files)) {
    if (typeof value === "string") form.append(name, await fileBlob(value), `${name}.bin`);
    else form.append(name, value, `${name}.bin`);
  }
  const { payload, headers } = await multipart(form);
  return api.app.inject({ method: "POST", url: "/v1/videos", payload, headers: { ...headers, authorization: `Bearer ${auth}` } });
}

async function waitDone(id: string, url = `/v1/videos/${id}`, headers: Record<string, string> = { authorization: `Bearer ${key}` }) {
  for (let i = 0; i < 600; i++) {
    const res = await api.app.inject({ method: "GET", url, headers });
    const body = res.json() as { status: string };
    if (body.status !== "queued" && body.status !== "processing") return body as Record<string, any>;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("tempo esgotado esperando o render");
}

before(async () => {
  assets = await makeTestAssets(TEST_ASSETS_DIR);
  dataDir = await mkdtemp(join(tmpdir(), "api-test-"));
  cfg = { ...loadConfig({}), dataDir, adminKey: ADMIN, cleanupMinutes: 0, rateLimitPerMinute: 0, createLimitPerMinute: 0, selftestWarmup: false };
  api = await buildApp(cfg, { logger: false });
  const res = await api.app.inject({ method: "POST", url: "/v1/admin/keys", headers: { "x-admin-key": ADMIN }, payload: { name: "testes" } });
  assert.equal(res.statusCode, 201);
  key = (res.json() as { key: string }).key;
});

after(async () => {
  await api?.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe("autenticação e consulta", () => {
  test("health é público", async () => {
    const res = await api.app.inject({ method: "GET", url: "/health" });
    assert.equal(res.statusCode, 200);
  });

  test("sem chave: 401 com mensagem em português", async () => {
    const res = await api.app.inject({ method: "GET", url: "/v1/presets" });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().error.code, "unauthorized");
  });

  test("chave errada e admin errado: 401", async () => {
    const a = await api.app.inject({ method: "GET", url: "/v1/presets", headers: { authorization: "Bearer vea_xxx" } });
    assert.equal(a.statusCode, 401);
    const b = await api.app.inject({ method: "GET", url: "/v1/admin/info?key=errada" });
    assert.equal(b.statusCode, 401);
  });

  test("lista presets, schema e plataformas", async () => {
    const h = { authorization: `Bearer ${key}` };
    const list = await api.app.inject({ method: "GET", url: "/v1/presets", headers: h });
    assert.ok((list.json().presets as { id: string }[]).some((p) => p.id === "limpo"));
    const one = await api.app.inject({ method: "GET", url: "/v1/presets/limpo", headers: h });
    assert.equal(one.json().id, "limpo");
    const missing = await api.app.inject({ method: "GET", url: "/v1/presets/nao-existe", headers: h });
    assert.equal(missing.statusCode, 404);
    const schema = await api.app.inject({ method: "GET", url: "/v1/presets/schema", headers: h });
    assert.equal(schema.json().type, "object");
    const platforms = await api.app.inject({ method: "GET", url: "/v1/platforms", headers: h });
    assert.ok(platforms.json().platforms.length >= 5);
  });

  test("admin por ?key= nas rotas GET (diagnóstico)", async () => {
    const res = await api.app.inject({ method: "GET", url: `/v1/admin/info?key=${ADMIN}` });
    assert.equal(res.statusCode, 200);
    const info = res.json();
    assert.equal(info.dataDirWritable, true);
    assert.equal(info.filters.xfade, true);
  });

  test("chave revogada deixa de funcionar", async () => {
    const created = await api.app.inject({ method: "POST", url: "/v1/admin/keys", headers: { "x-admin-key": ADMIN }, payload: { name: "temporária" } });
    const { id, key: temp } = created.json() as { id: string; key: string };
    const ok = await api.app.inject({ method: "GET", url: "/v1/platforms", headers: { authorization: `Bearer ${temp}` } });
    assert.equal(ok.statusCode, 200);
    const del = await api.app.inject({ method: "DELETE", url: `/v1/admin/keys/${id}`, headers: { "x-admin-key": ADMIN } });
    assert.equal(del.statusCode, 204);
    const denied = await api.app.inject({ method: "GET", url: "/v1/platforms", headers: { authorization: `Bearer ${temp}` } });
    assert.equal(denied.statusCode, 401);
    const list = await api.app.inject({ method: "GET", url: "/v1/admin/keys", headers: { "x-admin-key": ADMIN } });
    assert.ok(!JSON.stringify(list.json()).includes(temp), "a lista não pode expor a chave");
  });
});

describe("validação do pedido", () => {
  test("sem options: 400", async () => {
    const res = await postVideo(undefined, { foto: assets.photos[0]! });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error.code, "missing_options");
  });

  test("options enviado como application/json (como o curl -F 'options=<arquivo;type=application/json'): aceito", async () => {
    // Reproduz o que o curl envia: campo de texto com Content-Type application/json.
    const boundary = "----limite-teste";
    const photo = await readFile(assets.photos[0]!);
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="options"\r\nContent-Type: application/json\r\n\r\n`),
      Buffer.from(JSON.stringify({ items: [{ file: "foto" }], timing: { total: 3 } })),
      Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="foto"; filename="foto.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
      photo,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const res = await api.app.inject({
      method: "POST",
      url: "/v1/videos",
      payload,
      headers: { "content-type": `multipart/form-data; boundary=${boundary}`, authorization: `Bearer ${key}` },
    });
    assert.equal(res.statusCode, 202, res.body);
  });

  test("options com campo desconhecido: 400 explicando o campo", async () => {
    const res = await postVideo({ items: [{ file: "foto" }], cor: "azul" }, { foto: assets.photos[0]! });
    assert.equal(res.statusCode, 400);
    assert.match(res.json().error.message, /cor/);
  });

  test("arquivo citado e não enviado: 400", async () => {
    const res = await postVideo({ items: [{ file: "foto" }, { file: "outra" }] }, { foto: assets.photos[0]! });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error.code, "missing_file");
  });

  test("HEIC: 415 pedindo JPEG ou PNG", async () => {
    const heic = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypheic"), Buffer.alloc(64)]);
    const res = await postVideo({ items: [{ file: "foto" }] }, { foto: new Blob([heic]) });
    assert.equal(res.statusCode, 415);
    assert.match(res.json().error.message, /JPEG ou PNG/);
  });

  test("texto no lugar de foto: 415", async () => {
    const res = await postVideo({ items: [{ file: "foto" }] }, { foto: new Blob(["isto não é imagem"]) });
    assert.equal(res.statusCode, 415);
  });

  test("tipo declarado diferente do conteúdo: 415", async () => {
    const res = await postVideo({ items: [{ file: "foto", type: "clip" }] }, { foto: assets.photos[0]! });
    assert.equal(res.statusCode, 415);
  });

  test("erro de regra do motor vira 422 com o código do motor", async () => {
    const res = await postVideo(
      { items: [{ file: "foto" }], audio: { file: "musica", start: 500, duration: 10 } },
      { foto: assets.photos[0]!, musica: assets.tone },
    );
    assert.equal(res.statusCode, 422);
    assert.equal(res.json().error.code, "audio_segment_out_of_range");
  });

  test("ajuste fora da faixa: 422", async () => {
    const res = await postVideo(
      { items: [{ file: "foto" }], timing: { total: 5 }, overrides: { audio: { volume: 99 } } },
      { foto: assets.photos[0]! },
    );
    assert.equal(res.statusCode, 422);
    assert.equal(res.json().error.code, "invalid_overrides");
  });


  test("pedido rejeitado não deixa arquivos para trás", async () => {
    const jobs = await readdir(join(dataDir, "jobs"));
    const live = jobs.filter((d) => d !== "x");
    for (const d of live) {
      const res = await api.app.inject({ method: "GET", url: `/v1/admin/jobs/${d}?key=${ADMIN}` });
      assert.equal(res.statusCode, 200, `pasta órfã: ${d}`);
    }
  });
});

describe("render de ponta a ponta", () => {
  test("fotos + clipe com som + música: 202, progresso, download com Range e apagar", async () => {
    const res = await postVideo(
      {
        preset: "limpo",
        platform: "instagram_reels",
        items: [
          { file: "f1", caption: "Primeira" },
          { file: "c1", duration: 2, keepAudio: true },
          { file: "f2", focus: { x: 0.3, y: 0.5 } },
        ],
        audio: { file: "musica", start: 0, duration: 8 },
        overrides: { transition: { type: "wipeleft", duration: 0.4 } },
      },
      { f1: assets.photos[0]!, f2: assets.photos[1]!, c1: assets.clips.landscape, musica: assets.tone, sobra: assets.photos[2]! },
    );
    assert.equal(res.statusCode, 202, res.body);
    const created = res.json();
    assert.ok(created.warnings.some((w: string) => w.includes("sobra")), "avisa do arquivo não usado");

    const done = await waitDone(created.id);
    assert.equal(done.status, "done", JSON.stringify(done.error));
    assert.equal(done.progress, 100);
    assert.equal(done.result.width, 1080);
    assert.ok(Math.abs(done.result.duration - 8) < 0.05);
    assert.equal(done.result.stats, undefined, "estatísticas só para o admin");
    assert.ok(done.downloadUrl.endsWith(`/v1/videos/${created.id}/download`));

    // entradas apagadas depois do render
    await assert.rejects(readdir(join(dataDir, "jobs", created.id, "in")));

    const h = { authorization: `Bearer ${key}` };
    const full = await api.app.inject({ method: "GET", url: `/v1/videos/${created.id}/download`, headers: h });
    assert.equal(full.statusCode, 200);
    assert.equal(full.headers["content-type"], "video/mp4");
    assert.equal(full.rawPayload.subarray(4, 8).toString(), "ftyp");
    const part = await api.app.inject({ method: "GET", url: `/v1/videos/${created.id}/download`, headers: { ...h, range: "bytes=0-99" } });
    assert.equal(part.statusCode, 206);
    assert.equal(part.rawPayload.length, 100);

    // outra chave não enxerga o vídeo
    const other = await api.app.inject({ method: "POST", url: "/v1/admin/keys", headers: { "x-admin-key": ADMIN }, payload: { name: "outra" } });
    const notMine = await api.app.inject({ method: "GET", url: `/v1/videos/${created.id}`, headers: { authorization: `Bearer ${other.json().key}` } });
    assert.equal(notMine.statusCode, 404);

    const admin = await api.app.inject({ method: "GET", url: `/v1/admin/jobs/${created.id}?key=${ADMIN}` });
    assert.ok(admin.json().result.stats.renderSeconds > 0);

    const del = await api.app.inject({ method: "DELETE", url: `/v1/videos/${created.id}`, headers: h });
    assert.equal(del.statusCode, 204);
    const gone = await api.app.inject({ method: "GET", url: `/v1/videos/${created.id}/download`, headers: h });
    assert.equal(gone.statusCode, 410);
  });

  test("autoteste do admin", async () => {
    const res = await api.app.inject({ method: "GET", url: `/v1/admin/selftest?key=${ADMIN}&photos=3&clips=1&duration=10` });
    assert.equal(res.statusCode, 202, res.body);
    const done = await waitDone(res.json().id, `/v1/admin/jobs/${res.json().id}?key=${ADMIN}`, {});
    assert.equal(done.status, "done", JSON.stringify(done.error));
  });
});

describe("reinício", () => {
  test("pedido em processamento vira falha; pedido na fila é retomado", async () => {
    const dir = await mkdtemp(join(tmpdir(), "api-restart-"));
    const c = { ...cfg, dataDir: dir };
    const first = await buildApp(c, { logger: false });
    const photo = join(dir, "foto.jpg");
    await writeFile(photo, await readFile(assets.photos[0]!));
    const request = JSON.stringify({
      items: [{ type: "photo", file: photo }],
      preset: await (await import("@video-editor/engine")).loadPreset(join(cfg.presetsDir, "limpo.json")),
      platform: "instagram_reels",
      timing: { mode: "fixed", total: 3 },
    });
    first.db.insertJob({ id: "00000000-0000-0000-0000-000000000001", key_id: "k", created_at: 1, request_json: request, warnings_json: "[]", callback_url: null });
    first.db.update("00000000-0000-0000-0000-000000000001", { status: "processing" });
    first.db.insertJob({ id: "00000000-0000-0000-0000-000000000002", key_id: "k", created_at: 2, request_json: request, warnings_json: "[]", callback_url: null });
    await first.close();

    const second = await buildApp(c, { logger: false });
    try {
      const failed = second.db.job("00000000-0000-0000-0000-000000000001")!;
      assert.equal(failed.status, "failed");
      assert.match(failed.error_json!, /server_restarted/);
      for (let i = 0; i < 200 && second.db.job("00000000-0000-0000-0000-000000000002")!.status !== "done"; i++) {
        await new Promise((r) => setTimeout(r, 200));
      }
      assert.equal(second.db.job("00000000-0000-0000-0000-000000000002")!.status, "done");
    } finally {
      await second.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("limites de tamanho", () => {
  test("arquivo acima do limite: 413 e nada fica no disco", async () => {
    const dir = await mkdtemp(join(tmpdir(), "api-limits-"));
    const small = await buildApp(
      { ...cfg, dataDir: dir, limits: { ...cfg.limits, photo: 50_000, clip: 80_000, audio: 50_000, logo: 50_000, total: 10_000_000 } },
      { logger: false },
    );
    try {
      const k = (await small.app.inject({ method: "POST", url: "/v1/admin/keys", headers: { "x-admin-key": ADMIN }, payload: { name: "x" } })).json().key;
      for (const size of [60_000, 200_000]) {
        const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(size)]);
        const form = new FormData();
        form.append("options", JSON.stringify({ items: [{ file: "foto" }] }));
        form.append("foto", new Blob([jpeg]), "foto.jpg");
        const { payload, headers } = await multipart(form);
        const res = await small.app.inject({ method: "POST", url: "/v1/videos", payload, headers: { ...headers, authorization: `Bearer ${k}` } });
        assert.equal(res.statusCode, 413, res.body);
        assert.equal(res.json().error.code, "upload_too_large");
      }
      assert.deepEqual(await readdir(join(dir, "jobs")), []);
    } finally {
      await small.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
