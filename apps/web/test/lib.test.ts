import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  brandingSlots,
  buildRequest,
  classify,
  cropLoss,
  cropRect,
  formatTime,
  moveItem,
  naturalSort,
  parseTime,
  validateDraft,
  type Draft,
  type DraftItem,
} from "../src/lib.ts";

const file = (name: string, size = 1000, type = "image/jpeg") => new File([new Uint8Array(size)], name, { type });

function item(over: Partial<DraftItem> = {}): DraftItem {
  return { id: Math.random().toString(), kind: "photo", file: file("a.jpg"), url: "", caption: "", keepAudio: false, volume: 1, ...over };
}

function draft(over: Partial<Draft> = {}): Draft {
  return { preset: "limpo", platform: "instagram_reels", title: "", items: [item()], music: { kind: "none", duration: 15 }, logos: {}, ...over };
}

describe("tempo", () => {
  test("formata e lê", () => {
    assert.equal(formatTime(65.25), "1:05.3");
    assert.equal(formatTime(5, 0), "0:05");
    assert.equal(parseTime("65"), 65);
    assert.equal(parseTime("1:05,5"), 65.5);
    assert.equal(parseTime("0:75"), undefined);
    assert.equal(parseTime("abc"), undefined);
  });
});

describe("corte", () => {
  test("foto horizontal em 9:16: mantém a altura e corta as laterais, seguindo o foco", () => {
    const r = cropRect(4000, 3000, 9 / 16, { x: 0.9, y: 0.5 });
    assert.equal(r.h, 1);
    assert.ok(Math.abs(r.w - (9 / 16) / (4 / 3)) < 1e-9);
    assert.ok(Math.abs(r.x + r.w - 1) < 1e-9, "encosta na borda direita");
    assert.ok(cropLoss(4000, 3000, 9 / 16) > 0.5);
  });
  test("foto vertical no mesmo formato: nada é cortado", () => {
    assert.ok(cropLoss(1080, 1920, 9 / 16) < 1e-9);
  });
});

describe("pedido", () => {
  test("ordem do vídeo = ordem da lista; campos numerados", () => {
    const d = draft({
      items: [item({ file: file("z.jpg"), caption: " Largada " }), item({ kind: "clip", file: file("c.mp4", 10, "video/mp4"), sourceDuration: 10, start: 2, end: 6.5, keepAudio: true, volume: 0.6 })],
    });
    const { options, files } = buildRequest(d);
    assert.deepEqual(
      files.map(([f, file]) => [f, file.name]),
      [["item01", "z.jpg"], ["item02", "c.mp4"]],
    );
    assert.deepEqual(options.items, [
      { file: "item01", type: "photo", caption: "Largada" },
      { file: "item02", type: "clip", start: 2, end: 6.5, keepAudio: true, volume: 0.6 },
    ]);
    assert.deepEqual(options.timing, { mode: "fixed", total: 15 });
  });

  test("clipe inteiro não manda start/end; música do arquivo e logos", () => {
    const { options, files } = buildRequest(
      draft({
        items: [item({ kind: "clip", sourceDuration: 8, start: 0, end: 8 })],
        music: { kind: "file", file: file("m.mp3", 10, "audio/mpeg"), start: 30.1234, end: 50, loop: false },
        logos: { brand: file("logo.png", 10, "image/png") },
      }),
    );
    assert.deepEqual(options.items, [{ file: "item01", type: "clip" }]);
    assert.deepEqual(options.audio, { start: 30.123, end: 50, file: "musica" });
    assert.deepEqual(options.logos, [{ role: "brand", file: "logo_marca" }]);
    assert.deepEqual(files.map(([f]) => f), ["item01", "musica", "logo_marca"]);
  });

  test("música da biblioteca", () => {
    const { options } = buildRequest(draft({ music: { kind: "library", id: "piano", start: 0, end: 20, loop: true } }));
    assert.deepEqual(options.audio, { start: 0, end: 20, loop: true, libraryId: "piano" });
  });

  test("validação antes de enviar", () => {
    assert.deepEqual(validateDraft(draft()), []);
    assert.match(validateDraft(draft({ items: [] }))[0]!, /pelo menos uma/);
    assert.match(validateDraft(draft({ items: [item({ file: file("g.jpg", 16 * 1024 * 1024) })] }))[0]!, /15 MB/);
    assert.match(validateDraft(draft({ items: [item({ kind: "clip", start: 1, end: 1.5 })] }))[0]!, /1 segundo/);
  });
});

describe("arquivos", () => {
  test("classifica pelo tipo ou extensão", () => {
    assert.equal(classify({ name: "IMG_1.HEIC", type: "" }), "heic");
    assert.equal(classify({ name: "v.mov", type: "video/quicktime" }), "clip");
    assert.equal(classify({ name: "f.jpg", type: "image/jpeg" }), "photo");
    assert.equal(classify({ name: "f.gif", type: "image/gif" }), "unknown");
  });
  test("ordem natural dos nomes", () => {
    assert.deepEqual(naturalSort([{ name: "10.jpg" }, { name: "2.jpg" }, { name: "1.jpg" }]).map((f) => f.name), ["1.jpg", "2.jpg", "10.jpg"]);
  });
  test("mover item", () => {
    assert.deepEqual(moveItem([1, 2, 3, 4], 0, 2), [2, 3, 1, 4]);
    assert.deepEqual(moveItem([1, 2, 3], 2, 0), [3, 1, 2]);
  });
  test("onde o preset mostra cada logo", () => {
    assert.deepEqual(brandingSlots({ watermark: { role: "brand" }, outro: { role: "partner" }, intro: null }), {
      brand: ["marca d'água"],
      partner: ["cartão de encerramento"],
    });
  });
});
