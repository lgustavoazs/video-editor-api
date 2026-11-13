import assert from "node:assert/strict";
import { test } from "node:test";
import { buildFiltergraph, photoFilterToFfmpeg, temperatureToKelvin, zoomRange } from "../src/filtergraph.js";
import { getPlatform } from "../src/platforms.js";
import { parsePreset } from "../src/preset.js";
import { computeTiming } from "../src/timing.js";
import { EngineError } from "../src/errors.js";

const raw = {
  id: "teste",
  version: 1,
  name: "Teste",
  photo: { fit: "cover", filters: [{ type: "vignette", strength: 0.5 }, { type: "grain", amount: 10 }] },
  motion: { type: "kenburns", zoomFrom: 1, zoomTo: 1.2, direction: "alternate" },
  transition: { type: "fade", duration: 0.5 },
  timing: { perPhotoMin: 1, perPhotoMax: 6 },
  audio: { fadeIn: 0.5, fadeOut: 1, volume: 0.8 },
};

test("parsePreset aplica padrões e rejeita valores fora da faixa", () => {
  const preset = parsePreset(raw);
  assert.equal(preset.motion.zoomTo, 1.2);
  assert.throws(
    () => parsePreset({ ...raw, transition: { type: "fade", duration: 99 } }),
    (err) => err instanceof EngineError && err.code === "invalid_preset",
  );
  assert.throws(
    () => parsePreset({ ...raw, photo: { fit: "cover", filters: [{ type: "glitch" }] } }),
    (err) => err instanceof EngineError && err.code === "invalid_preset",
  );
});

test("filtros neutros não geram nada", () => {
  assert.deepEqual(photoFilterToFfmpeg({ type: "color" }), []);
  assert.deepEqual(photoFilterToFfmpeg({ type: "vignette", strength: 0 }), []);
  assert.deepEqual(photoFilterToFfmpeg({ type: "grain", amount: 0 }), []);
});

test("temperatura positiva esquenta (Kelvin menor)", () => {
  assert.equal(temperatureToKelvin(0), 6500);
  assert.ok(temperatureToKelvin(0.5) < 6500);
  assert.ok(temperatureToKelvin(-0.5) > 6500);
});

test("direção alternate inverte o zoom a cada foto", () => {
  const preset = parsePreset(raw);
  assert.deepEqual(zoomRange(preset, 0), { from: 1, to: 1.2 });
  assert.deepEqual(zoomRange(preset, 1), { from: 1.2, to: 1 });
});

test("filtergraph: um ramo por foto, xfade encadeado e áudio cortado no trecho", () => {
  const preset = parsePreset(raw);
  const platform = getPlatform("instagram_reels");
  const timing = computeTiming({
    photoCount: 3, fps: 30, transition: 0.5, perPhotoMin: 1, perPhotoMax: 6,
    maxDuration: 60, mode: "fixed", requestedTotal: 8,
  });
  const g = buildFiltergraph({
    preset, platform, timing, photoCount: 3,
    audio: { inputIndex: 3, start: 42.5, length: timing.total },
  });

  assert.equal((g.graph.match(/zoompan=/g) ?? []).length, 3);
  assert.equal((g.graph.match(/xfade=/g) ?? []).length, 2);
  assert.equal(g.videoLabel, "x2");
  assert.equal(g.audioLabel, "aout");
  assert.match(g.graph, /s=1080x1920:fps=30/);
  assert.match(g.graph, /\[3:a\]atrim=start=42\.5:end=/);
  assert.match(g.graph, /afade=t=in:st=0:d=0\.5/);
  assert.match(g.graph, /volume=0\.8/);

  // cada transição começa no fim do clipe anterior, menos a sobreposição
  const offsets = [...g.graph.matchAll(/offset=([\d.]+)/g)].map((m) => Number(m[1]));
  const first = (timing.clipFrames[0]! - timing.transitionFrames) / 30;
  const second = first + (timing.clipFrames[1]! - timing.transitionFrames) / 30;
  assert.ok(Math.abs(offsets[0]! - first) < 1e-5);
  assert.ok(Math.abs(offsets[1]! - second) < 1e-5);
});

test("filtergraph: uma foto não usa transição; sem áudio não cria ramo de áudio", () => {
  const preset = parsePreset(raw);
  const timing = computeTiming({
    photoCount: 1, fps: 30, transition: 0.5, perPhotoMin: 1, perPhotoMax: 6,
    maxDuration: 60, mode: "fixed", requestedTotal: 4,
  });
  const g = buildFiltergraph({ preset, platform: getPlatform("facebook_feed"), timing, photoCount: 1 });
  assert.equal(g.videoLabel, "v0");
  assert.equal(g.audioLabel, undefined);
  assert.doesNotMatch(g.graph, /xfade|atrim/);
  assert.match(g.graph, /s=1080x1350/);
});
