import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  approxLook,
  canonical,
  defaultsFor,
  exportPreset,
  fieldKind,
  getAt,
  newFilter,
  setAt,
  slugify,
} from "../src/editor/schemaUtil.ts";

const schema = {
  properties: {
    photo: {
      properties: {
        filters: {
          items: {
            oneOf: [
              { properties: { type: { const: "vignette" }, strength: { type: "number", default: 0.3 } } },
              { properties: { type: { const: "lut" }, file: { type: "string" } }, required: ["type", "file"] },
            ],
          },
        },
      },
    },
  },
};

describe("schema", () => {
  test("tipo de campo", () => {
    assert.equal(fieldKind({ type: "number", minimum: 0 }), "number");
    assert.equal(fieldKind({ type: "string", enum: ["a"] }), "enum");
    assert.equal(fieldKind({ type: "string", pattern: "^#[0-9a-fA-F]{6}$" }), "color");
    assert.equal(fieldKind({ type: ["object", "null"] }), "object");
  });
  test("padrões ao ligar um bloco, com papel obrigatório preenchido", () => {
    const card = {
      required: ["role"],
      properties: { role: { enum: ["brand", "partner"] }, duration: { default: 2 }, caption: { type: "string" } },
    };
    assert.deepEqual(defaultsFor(card), { role: "brand", duration: 2 });
  });
  test("filtro novo com padrões; LUT pega o primeiro arquivo", () => {
    assert.deepEqual(newFilter(schema, "vignette"), { type: "vignette", strength: 0.3 });
    assert.deepEqual(newFilter(schema, "lut", ["a.cube"]), { type: "lut", file: "a.cube" });
  });
  test("ler e trocar valor por caminho sem alterar o original", () => {
    const o = { text: { title: { size: 0.05 } } };
    const n = setAt(o, ["text", "title", "size"], 0.07);
    assert.equal(getAt(n, ["text", "title", "size"]), 0.07);
    assert.equal(o.text.title.size, 0.05);
    assert.deepEqual(setAt({ a: 1, b: 2 }, ["b"], undefined), { a: 1 });
  });
});

describe("exportar", () => {
  const base = { id: "limpo", name: "Limpo", version: 1, motion: { type: "kenburns", zoomTo: 1.1 }, letterbox: 0, text: null };
  test("herda do base e traz só os blocos diferentes", () => {
    const cur = { ...base, id: "meu", name: "Meu", motion: { zoomTo: 1.1, type: "kenburns" }, letterbox: 0.08 };
    assert.deepEqual(exportPreset(cur, base, "limpo"), { id: "meu", version: 1, name: "Meu", extends: "limpo", letterbox: 0.08 });
  });
  test("bloco desligado sai como null", () => {
    const b = { ...base, text: { title: {} } };
    const out = exportPreset({ ...b, id: "x", text: null }, b, "limpo");
    assert.equal(out.text, null);
  });
  test("comparação ignora a ordem das chaves", () => {
    assert.equal(canonical({ a: 1, b: [1, { c: 2, d: 3 }] }), canonical({ b: [1, { d: 3, c: 2 }], a: 1 }));
  });
  test("id a partir do nome", () => {
    assert.equal(slugify("Retrô Quente 2"), "retro-quente-2");
    assert.equal(slugify("!!!"), "novo-estilo");
  });
});

describe("prévia aproximada", () => {
  test("filtros viram CSS; os que não dá para imitar ficam listados", () => {
    const look = approxLook([
      { type: "color", brightness: 0.1, contrast: 1.2, saturation: 0.8, temperature: 0.5 },
      { type: "grayscale", amount: 0.5 },
      { type: "vignette", strength: 0.4 },
      { type: "grain", amount: 12 },
      { type: "lut", file: "x.cube" },
      { type: "clarity", amount: 0.5 },
    ]);
    assert.equal(look.css, "brightness(1.100) contrast(1.2) saturate(0.8) grayscale(0.5)");
    assert.equal(look.tint!.color, "rgb(255,140,40)");
    assert.equal(look.vignette, 0.4);
    assert.equal(look.grain, 12);
    assert.deepEqual(look.sampleOnly, ["lut", "clarity"]);
  });
});
