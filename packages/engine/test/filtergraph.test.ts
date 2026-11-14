import assert from "node:assert/strict";
import { test } from "node:test";
import { buildFiltergraph, panDirection, zoomRange, type Segment } from "../src/filtergraph.js";
import { photoFilterToFfmpeg, temperatureToKelvin } from "../src/filters.js";
import { getPlatform } from "../src/platforms.js";
import { coverLoss, resolveFit } from "../src/prepare.js";
import { parsePreset } from "../src/preset.js";
import { wrapText, type TextLayout } from "../src/text.js";

const ctx = { lutsDir: "/luts" };
const layout: TextLayout = { frameWidth: 1080, frameHeight: 1920, marginTop: 300, marginBottom: 700, marginSide: 90 };

const preset = parsePreset({
  id: "teste",
  version: 1,
  name: "Teste",
  photo: { filters: [{ type: "vignette", strength: 0.5 }, { type: "grain", amount: 10 }] },
  motion: { type: "kenburns", zoomFrom: 1, zoomTo: 1.2, direction: "alternate", pan: "alternate" },
  transition: { type: "fade", duration: 0.5 },
  timing: { perPhotoMin: 1, perPhotoMax: 6 },
  audio: { fadeIn: 0.5, fadeOut: 1, volume: 0.8 },
  letterbox: 0.05,
  text: { title: {}, caption: {} },
});

const photo = (frames: number, extra: Partial<Segment> = {}): Segment =>
  ({ kind: "photo", frames, zoomFrom: 1, zoomTo: 1.2, pan: "none", focus: { x: 0.5, y: 0.5 }, ...extra }) as Segment;

test("filtros neutros não geram nada; os demais viram filtros do FFmpeg", () => {
  assert.deepEqual(photoFilterToFfmpeg({ type: "color" }, ctx), []);
  assert.deepEqual(photoFilterToFfmpeg({ type: "vignette", strength: 0 }, ctx), []);
  assert.deepEqual(photoFilterToFfmpeg({ type: "grayscale", amount: 0 }, ctx), []);
  assert.deepEqual(photoFilterToFfmpeg({ type: "grayscale", amount: 1 }, ctx), ["hue=s=0"]);
  assert.match(photoFilterToFfmpeg({ type: "lut", file: "cinema.cube" }, ctx)[0]!, /^lut3d=file='\/luts\/cinema\.cube'$/);
  assert.match(photoFilterToFfmpeg({ type: "sepia", amount: 1 }, ctx)[0]!, /rr=0\.393/);
  // o filtro unsharp do FFmpeg aceita matriz de no máximo 13x13
  assert.match(photoFilterToFfmpeg({ type: "clarity", amount: 0.5 }, ctx)[0]!, /lx=13:ly=13/);
});

test("temperatura positiva esquenta (Kelvin menor)", () => {
  assert.equal(temperatureToKelvin(0), 6500);
  assert.ok(temperatureToKelvin(0.5) < 6500);
  assert.ok(temperatureToKelvin(-0.5) > 6500);
});

test("zoom e deslocamento alternam a cada foto", () => {
  assert.deepEqual(zoomRange(preset.motion, 0), { from: 1, to: 1.2 });
  assert.deepEqual(zoomRange(preset.motion, 1), { from: 1.2, to: 1 });
  assert.equal(panDirection(preset.motion, 0), "right");
  assert.equal(panDirection(preset.motion, 1), "left");
  assert.equal(panDirection({ ...preset.motion, pan: "none" }, 0), "none");
});

test("enquadramento automático: foto horizontal em quadro vertical vira contain; foco força o corte", () => {
  // 3:2 em 9:16 perde 62,5% no corte
  assert.ok(Math.abs(coverLoss(3000, 2000, 1080, 1920) - 0.625) < 1e-9);
  assert.equal(resolveFit(preset.photo, 0.625, false), "contain");
  assert.equal(resolveFit(preset.photo, 0.625, true), "cover");
  assert.equal(resolveFit(preset.photo, 0.25, false), "cover");
  assert.equal(resolveFit({ ...preset.photo, fit: "cover" }, 0.9, false), "cover");
});

test("quebra de linha não parte palavras e respeita o limite", () => {
  assert.deepEqual(wrapText("um texto de teste bem simples", 12), ["um texto de", "teste bem", "simples"]);
  assert.deepEqual(wrapText("  espaços   e\nquebras ", 40), ["espaços e quebras"]);
  assert.ok(wrapText("palavraextremamentelonga", 8).every((l) => l.length <= 8));
});

test("filtergraph completo: fotos, cartão, transições, acabamento e áudio em loop", () => {
  const platform = getPlatform("instagram_reels");
  const segments: Segment[] = [
    { kind: "card", frames: 60 },
    photo(100, { captionFile: "/tmp/legenda.txt" } as Partial<Segment>),
    photo(99, { pan: "left" } as Partial<Segment>),
    { kind: "card", frames: 60, caption: { textFile: "/tmp/apoio.txt", y: 1200, color: "#ffffff" } },
  ];
  const tf = 15;
  const totalFrames = 60 + 100 + 99 + 60 - 3 * tf;
  const g = buildFiltergraph({
    preset, platform, segments,
    transitions: ["fade", "slideleft", "fade"],
    transitionFrames: tf,
    total: totalFrames / 30,
    filterContext: ctx,
    fontsDir: "/fonts",
    layout,
    title: { textFile: "/tmp/titulo.txt" },
    watermark: { inputIndex: 4, x: 800, y: 300, opacity: 0.8, windows: [{ from: 1.75, to: 7.9 }] },
    audio: { inputIndex: 5, start: 32, segmentLength: 4, loop: true },
  });

  assert.equal((g.graph.match(/zoompan=/g) ?? []).length, 4);
  assert.deepEqual([...g.graph.matchAll(/xfade=transition=([a-z]+)/g)].map((m) => m[1]), ["fade", "slideleft", "fade"]);
  // cada transição começa no fim do trecho anterior, menos a sobreposição
  const offsets = [...g.graph.matchAll(/offset=([\d.]+)/g)].map((m) => Number(m[1]));
  const expected = [(60 - tf) / 30, (60 + 100 - 2 * tf) / 30, (60 + 100 + 99 - 3 * tf) / 30];
  assert.equal(offsets.length, 3);
  offsets.forEach((o, i) => assert.ok(Math.abs(o - expected[i]!) < 1e-5));
  // filtros do preset só nas fotos (2 fotos)
  assert.equal((g.graph.match(/vignette=/g) ?? []).length, 2);
  // legenda da foto, texto do cartão e título
  assert.equal((g.graph.match(/drawtext=/g) ?? []).length, 3);
  assert.equal((g.graph.match(/drawbox=/g) ?? []).length, 2);
  assert.match(g.graph, /\[4:v\]format=rgba,colorchannelmixer=aa=0\.8\[wm\]/);
  assert.match(g.graph, /overlay=x=800:y=300:enable='between\(t,1\.75,7\.9\)'/);
  // áudio: corta o trecho, repete e corta na duração do vídeo
  assert.match(g.graph, /\[5:a\]atrim=start=32:end=36,asetpts=PTS-STARTPTS,aresample=48000,aloop=loop=-1:size=192000/);
  assert.match(g.graph, /volume=0\.8/);
  assert.equal(g.videoLabel, "vwm");
  assert.equal(g.audioLabel, "aout");
});

test("uma foto, sem extras: sem transição, sem áudio, no formato do perfil", () => {
  const simple = parsePreset({
    id: "simples", version: 1, name: "Simples", photo: {}, motion: { type: "none" },
    transition: { type: "fade", duration: 0.5 }, timing: { perPhotoMin: 1, perPhotoMax: 6 },
  });
  const g = buildFiltergraph({
    preset: simple, platform: getPlatform("facebook_feed"), segments: [photo(120)],
    transitions: [], transitionFrames: 0, total: 4, filterContext: ctx, fontsDir: "/fonts", layout,
  });
  assert.equal(g.videoLabel, "v0");
  assert.equal(g.audioLabel, undefined);
  assert.doesNotMatch(g.graph, /xfade|atrim|drawtext|overlay/);
  assert.match(g.graph, /s=1080x1350/);
});
