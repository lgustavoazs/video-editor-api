import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { EngineError } from "../src/errors.js";
import { loadPreset, mergePreset, parsePreset } from "../src/preset.js";
import { ALL_TRANSITIONS, pickTransitions } from "../src/transitions.js";

const here = dirname(fileURLToPath(import.meta.url));
const PRESETS = join(here, "../../../presets");
const FIXTURES = join(here, "fixtures");

const minimal = {
  id: "teste",
  version: 1,
  name: "Teste",
  photo: {},
  motion: { type: "kenburns" },
  transition: { type: "fade", duration: 0.5 },
  timing: { perPhotoMin: 1, perPhotoMax: 6 },
};

function invalid(raw: unknown): EngineError {
  try {
    parsePreset(raw);
  } catch (err) {
    assert.ok(err instanceof EngineError && err.code === "invalid_preset", String(err));
    return err;
  }
  assert.fail("esperava preset inválido");
}

test("preset mínimo recebe os padrões do schema", () => {
  const p = parsePreset(structuredClone(minimal));
  assert.equal(p.photo.fit, "auto");
  assert.equal(p.photo.background.type, "blur");
  assert.deepEqual(p.photo.filters, []);
  assert.equal(p.motion.pan, "none");
  assert.deepEqual(p.transition.types, ["fade"]);
  assert.equal(p.transition.order, "cycle");
  assert.equal(p.audio.volume, 1);
  assert.equal(p.letterbox, 0);
  assert.equal(p.text, null);
  assert.equal(p.branding, null);
});

test("valores fora da faixa, filtros e transições desconhecidos são rejeitados em português", () => {
  const range = invalid({ ...minimal, transition: { type: "fade", duration: 99 } });
  assert.match(range.message, /\/transition\/duration/);
  assert.match(range.message, /deve ser <= 3/);
  invalid({ ...minimal, photo: { filters: [{ type: "glitch" }] } });
  invalid({ ...minimal, transition: { type: "teletransporte", duration: 0.5 } });
  invalid({ ...minimal, transition: { type: "fade", types: ["fade"], duration: 0.5 } });
  invalid({ ...minimal, photo: { filters: [{ type: "lut", file: "../segredo.cube" }] } });
  invalid({ ...minimal, campoDesconhecido: 1 });
  invalid({ ...minimal, timing: { perPhotoMin: 5, perPhotoMax: 2 } });
});

test("blocos de texto e logo recebem padrões quando presentes", () => {
  const p = parsePreset({
    ...structuredClone(minimal),
    text: { title: {} },
    branding: { watermark: { role: "brand" }, between: { role: "partner" } },
  });
  assert.equal(p.text?.title?.position, "top");
  assert.equal(p.text?.caption, null);
  assert.equal(p.branding?.watermark?.position, "top-right");
  assert.equal(p.branding?.between?.every, 3);
  assert.equal(p.branding?.intro, null);
});

test("herança: o filho sobrescreve só o que muda; listas são substituídas; null desliga", () => {
  const parent = { a: 1, b: { c: 2, d: 3 }, list: [1, 2], off: { x: 1 } };
  const child = { b: { c: 9 }, list: [7], off: null };
  assert.deepEqual(mergePreset(parent, child), { a: 1, b: { c: 9, d: 3 }, list: [7], off: null });
});

test("o preset limpo e os de teste carregam, com herança resolvida", async () => {
  const limpo = await loadPreset(join(PRESETS, "limpo.json"));
  assert.equal(limpo.id, "limpo");

  const all = await loadPreset(join(FIXTURES, "teste-todos-efeitos.json"), { presetsDir: PRESETS });
  assert.equal(all.id, "teste-todos-efeitos");
  // herdado do limpo
  assert.equal(all.timing.perPhotoMax, 6);
  // o filho usa "types"; o "type" do pai não pode sobrar
  assert.equal(all.transition.types.length, 6);
  assert.equal(all.transition.order, "random");
  assert.equal(all.photo.filters.length, 10);
  assert.equal(all.branding?.outro?.caption, "Patrocínio oficial");
});

test("extends inexistente falha com mensagem clara", async () => {
  await assert.rejects(
    loadPreset(join(FIXTURES, "teste-todos-efeitos.json"), { presetsDir: FIXTURES }),
    (err) => err instanceof EngineError && err.code === "invalid_preset" && /não encontrado/.test(err.message),
  );
});

test("são 58 transições, sem repetição", () => {
  assert.equal(ALL_TRANSITIONS.length, 58);
  assert.equal(new Set(ALL_TRANSITIONS).size, 58);
});

test("rodízio percorre a lista; sorteio é determinístico e não repete em sequência", () => {
  const types = ["fade", "slideleft", "wipeup"] as const;
  assert.deepEqual(
    pickTransitions({ types: [...types], order: "cycle", seed: 1, duration: 0.5 }, 5),
    ["fade", "slideleft", "wipeup", "fade", "slideleft"],
  );
  const a = pickTransitions({ types: [...types], order: "random", seed: 42, duration: 0.5 }, 40);
  const b = pickTransitions({ types: [...types], order: "random", seed: 42, duration: 0.5 }, 40);
  const c = pickTransitions({ types: [...types], order: "random", seed: 43, duration: 0.5 }, 40);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
  assert.ok(a.every((t, i) => i === 0 || t !== a[i - 1]));
  assert.equal(new Set(a).size, 3);
});
