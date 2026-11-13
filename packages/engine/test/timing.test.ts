import assert from "node:assert/strict";
import { test } from "node:test";
import { EngineError } from "../src/errors.js";
import { computeTiming, parseTime, resolveAudioSegment } from "../src/timing.js";

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof EngineError, `esperava EngineError, veio ${String(err)}`);
    return err.code;
  }
  assert.fail("esperava erro");
}

const base = { fps: 30, transition: 0.6, perPhotoMin: 1.5, perPhotoMax: 6, maxDuration: 60 };

test("parseTime aceita segundos e mm:ss.mmm", () => {
  assert.equal(parseTime(42.5), 42.5);
  assert.equal(parseTime("42.5"), 42.5);
  assert.equal(parseTime("0:42.5"), 42.5);
  assert.equal(parseTime("1:12.250"), 72.25);
  assert.equal(parseTime("1:02:03"), 3723);
  assert.equal(code(() => parseTime("1:75")), "invalid_time");
  assert.equal(code(() => parseTime("abc")), "invalid_time");
  assert.equal(code(() => parseTime(-1)), "invalid_time");
});

test("trecho: start/end, start/duration e padrões", () => {
  assert.deepEqual(resolveAudioSegment({ start: 42.5, end: 72.5 }, 180), {
    start: 42.5, end: 72.5, length: 30, loop: false,
  });
  assert.equal(resolveAudioSegment({ start: "0:10", duration: 20 }, 180).end, 30);
  assert.equal(resolveAudioSegment({}, 45).length, 45);
  assert.equal(resolveAudioSegment({ start: 40 }, 45).length, 5);
});

test("trecho: erros de validação", () => {
  assert.equal(code(() => resolveAudioSegment({ end: 10, duration: 10 }, 60)), "invalid_audio_segment");
  assert.equal(code(() => resolveAudioSegment({ start: 20, end: 10 }, 60)), "invalid_audio_segment");
  assert.equal(code(() => resolveAudioSegment({ start: 70 }, 60)), "audio_segment_out_of_range");
  assert.equal(code(() => resolveAudioSegment({ start: 10, end: 90 }, 60)), "audio_segment_out_of_range");
  assert.equal(code(() => resolveAudioSegment({ start: 10, end: 12 }, 60)), "audio_segment_too_short");
});

test("modo audio: fotos dividem a duração do trecho", () => {
  const segment = resolveAudioSegment({ start: 5, duration: 15 }, 45);
  const r = computeTiming({ ...base, photoCount: 6, mode: "audio", segment });
  // d = (15 + 5*0.6)/6 = 3 s -> 90 quadros; transição 18 quadros
  assert.deepEqual(r.clipFrames, [90, 90, 90, 90, 90, 90]);
  assert.equal(r.transitionFrames, 18);
  assert.equal(r.totalFrames, 6 * 90 - 5 * 18);
  assert.equal(r.total, 15);
  assert.deepEqual(r.warnings, []);
});

test("modo audio: trecho maior que o máximo da plataforma é cortado com aviso", () => {
  const segment = resolveAudioSegment({ start: 0, end: 90 }, 120);
  const r = computeTiming({ ...base, photoCount: 20, mode: "audio", segment });
  assert.equal(r.total, 60);
  assert.equal(r.warnings.length, 1);
});

test("modo audio sem áudio falha", () => {
  assert.equal(code(() => computeTiming({ ...base, photoCount: 3, mode: "audio" })), "audio_required");
});

test("modo fixed: trecho curto sem loop falha; com loop passa", () => {
  const short = resolveAudioSegment({ start: 0, duration: 10 }, 60);
  assert.equal(
    code(() => computeTiming({ ...base, photoCount: 5, mode: "fixed", requestedTotal: 20, segment: short })),
    "audio_segment_too_short",
  );
  const r = computeTiming({
    ...base, photoCount: 5, mode: "fixed", requestedTotal: 20, segment: { ...short, loop: true },
  });
  assert.equal(r.total, 20);
  // 600 quadros + 4 transições de 18 = 672 a dividir por 5: resto 2 vai para os primeiros clipes
  assert.deepEqual(r.clipFrames, [135, 135, 134, 134, 134]);
  assert.equal(r.clipFrames.reduce((a, b) => a + b, 0) - 4 * r.transitionFrames, r.totalFrames);
});

test("fotos demais: erro informa o máximo suportado", () => {
  try {
    computeTiming({ ...base, photoCount: 20, mode: "fixed", requestedTotal: 15 });
    assert.fail("esperava erro");
  } catch (err) {
    assert.ok(err instanceof EngineError);
    assert.equal(err.code, "too_many_photos");
    // (15 - 0.6) / 1.5 = 9.6 -> 9 fotos
    assert.equal(err.details.maxPhotos, 9);
  }
});

test("poucas fotos: duração é reduzida com aviso", () => {
  const r = computeTiming({ ...base, photoCount: 2, mode: "fixed", requestedTotal: 30 });
  // 2 fotos * 6 s + 0.6 s de transição
  assert.equal(r.total, 12.6);
  assert.equal(r.warnings.length, 1);
});

test("uma foto: sem transição", () => {
  const r = computeTiming({ ...base, photoCount: 1, mode: "fixed", requestedTotal: 4 });
  assert.equal(r.transitionFrames, 0);
  assert.equal(r.totalFrames, 120);
});
