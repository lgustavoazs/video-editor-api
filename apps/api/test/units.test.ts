import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { loadPreset, PRESETS_DIR } from "@video-editor/engine";
import { join } from "node:path";
import { RateLimiter } from "../src/keys.js";
import { parseOptions, referencedFiles } from "../src/options.js";
import { applyOverrides } from "../src/presets.js";
import { sniff } from "../src/sniff.js";

const head = (...parts: (string | number[])[]) =>
  Buffer.concat(parts.map((p) => (typeof p === "string" ? Buffer.from(p, "latin1") : Buffer.from(p))));

describe("identificação pelo conteúdo", () => {
  test("formatos comuns", () => {
    assert.equal(sniff(head([0xff, 0xd8, 0xff, 0xe0])).format, "jpeg");
    assert.equal(sniff(head([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])).format, "png");
    assert.equal(sniff(head("RIFF", [0, 0, 0, 0], "WEBP")).format, "webp");
    assert.equal(sniff(head("RIFF", [0, 0, 0, 0], "WAVE")).kind, "audio");
    assert.equal(sniff(head([0, 0, 0, 0x20], "ftypisom")).kind, "video");
    assert.equal(sniff(head([0, 0, 0, 0x14], "ftypqt  ")).format, "mov");
    assert.equal(sniff(head([0, 0, 0, 0x20], "ftypM4A ")).kind, "audio");
    assert.equal(sniff(head([0, 0, 0, 0x18], "ftypheic")).kind, "heic");
    assert.equal(sniff(head([0, 0, 0, 0x18], "ftypmif1")).kind, "heic");
    assert.equal(sniff(head("ID3", [4, 0])).format, "mp3");
    assert.equal(sniff(head([0xff, 0xfb, 0x90])).format, "mp3");
    assert.equal(sniff(head([0x1a, 0x45, 0xdf, 0xa3])).kind, "video");
    assert.equal(sniff(head("texto qualquer")).kind, "unknown");
  });
});

describe("opções", () => {
  test("aceita o formato mínimo", () => {
    const o = parseOptions(JSON.stringify({ items: [{ file: "a" }] }));
    assert.deepEqual([...referencedFiles(o).keys()], ["a"]);
  });

  test("rejeita o mesmo arquivo em usos diferentes", () => {
    const o = parseOptions(JSON.stringify({ items: [{ file: "a" }], logos: [{ role: "brand", file: "a" }] }));
    assert.throws(() => referencedFiles(o), /já é usado/);
  });

  test("rejeita papel de logo repetido e callback que não é endereço web", () => {
    assert.throws(
      () => parseOptions(JSON.stringify({ items: [{ file: "a" }], logos: [{ role: "brand", file: "b" }, { role: "brand", file: "c" }] })),
      /uma vez só/,
    );
    assert.throws(() => parseOptions(JSON.stringify({ items: [{ file: "a" }], callbackUrl: "ftp://x" })), /https/);
  });

  test("tempo aceita número ou texto", () => {
    parseOptions(JSON.stringify({ items: [{ file: "a", start: "0:05", duration: 3 }] }));
    assert.throws(() => parseOptions(JSON.stringify({ items: [{ file: "a", start: true }] })), /segundos/);
  });
});

describe("ajustes do preset", () => {
  test("type substitui types e as faixas são revalidadas", async () => {
    const base = await loadPreset(join(PRESETS_DIR, "limpo.json"));
    const p = applyOverrides({ ...base, transition: { ...base.transition, type: undefined, types: ["fade", "wipeleft"] } } as never, {
      transition: { type: "circleopen", duration: 1 },
    });
    assert.deepEqual(p.transition.types, ["circleopen"]);
    assert.equal(p.transition.duration, 1);
    assert.throws(() => applyOverrides(base, { audio: { clipDucking: 5 } }), /faixas/);
  });
});

describe("limite por minuto", () => {
  test("bloqueia depois do limite e libera na janela seguinte", () => {
    const rl = new RateLimiter(2);
    assert.equal(rl.hit("k", 0), 0);
    assert.equal(rl.hit("k", 1), 0);
    assert.ok(rl.hit("k", 2) > 0);
    assert.equal(rl.hit("k", 60_001), 0);
  });
});

describe("banco criado na Fase 2A", () => {
  test("ganha as colunas novas sem perder dados", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { DatabaseSync } = await import("node:sqlite");
    const { Db } = await import("../src/db.js");
    const dir = mkdtempSync(join(tmpdir(), "db-2a-"));
    try {
      const old = new DatabaseSync(join(dir, "api.sqlite"));
      old.exec(`
        CREATE TABLE api_keys (id TEXT PRIMARY KEY, name TEXT NOT NULL, hash TEXT NOT NULL UNIQUE, prefix TEXT NOT NULL,
          created_at INTEGER NOT NULL, revoked_at INTEGER, last_used_at INTEGER);
        CREATE TABLE jobs (id TEXT PRIMARY KEY, key_id TEXT NOT NULL, status TEXT NOT NULL, progress REAL NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER, expires_at INTEGER, request_json TEXT NOT NULL,
          result_json TEXT, error_json TEXT, warnings_json TEXT NOT NULL DEFAULT '[]', callback_url TEXT, output_bytes INTEGER);
        INSERT INTO api_keys VALUES ('k1', 'gustavo', 'h', 'vea_ab', 1, NULL, NULL);
        INSERT INTO jobs (id, key_id, status, created_at, request_json) VALUES ('j1', 'k1', 'done', 1, '{}');
      `);
      old.close();
      const db = new Db(dir);
      assert.equal(db.key("k1")!.webhook_secret, null);
      assert.equal(db.job("j1")!.kind, "video");
      assert.equal(db.job("j1")!.webhook_attempts, 0);
      db.close();
      new Db(dir).close(); // abrir de novo não tenta recriar as colunas
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
