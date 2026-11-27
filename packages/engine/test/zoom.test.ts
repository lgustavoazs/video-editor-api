import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import sharp from "sharp";
import { ENGINE_ASSETS, PRESETS_DIR } from "../src/cli/paths.js";
import { EngineError } from "../src/errors.js";
import { getPlatform, listPlatforms } from "../src/platforms.js";
import { preparePhoto } from "../src/prepare.js";
import { loadPreset, parsePreset } from "../src/preset.js";
import { planRender } from "../src/render.js";

let dir: string;
let photo: string;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "zoom-"));
  // Foto 2000x1000: metade esquerda vermelha, metade direita azul.
  photo = join(dir, "metades.png");
  const half = (r: number, b: number) => sharp({ create: { width: 1000, height: 1000, channels: 3, background: { r, g: 0, b } } }).png().toBuffer();
  await sharp({ create: { width: 2000, height: 1000, channels: 3, background: { r: 0, g: 0, b: 0 } } })
    .composite([
      { input: await half(255, 0), left: 0, top: 0 },
      { input: await half(0, 255), left: 1000, top: 0 },
    ])
    .png()
    .toFile(photo);
});

after(() => rm(dir, { recursive: true, force: true }));

async function means(file: string) {
  const s = await sharp(file).stats();
  return { r: s.channels[0]!.mean, b: s.channels[2]!.mean };
}

test("zoom na foto: área menor, centrada no ponto, e força o corte mesmo em estilo 'contain'", async () => {
  const contain = parsePreset({
    id: "x", version: 1, name: "x", photo: { fit: "contain" }, motion: { type: "none" },
    transition: { type: "fade", duration: 0.5 }, timing: { perPhotoMin: 1, perPhotoMax: 6 },
  }).photo;
  const cover = { ...contain, fit: "cover" as const };

  // Sem zoom, centrada: o quadro 4:5 pega as duas metades.
  const a = join(dir, "a.jpg");
  const pa = await preparePhoto(photo, a, 400, 500, cover, { x: 0.5, y: 0.5 });
  const ma = await means(a);
  assert.equal(pa.fit, "cover");
  assert.ok(ma.r > 60 && ma.b > 60, "mistura vermelho e azul");

  // Zoom 2 à direita: só azul, e o tamanho de saída continua o do quadro.
  const b = join(dir, "b.jpg");
  const pb = await preparePhoto(photo, b, 400, 500, contain, { x: 0.85, y: 0.5 }, 2);
  assert.equal(pb.fit, "cover", "zoom força o corte");
  const meta = await sharp(b).metadata();
  assert.equal(meta.width, 400);
  assert.equal(meta.height, 500);
  const mb = await means(b);
  assert.ok(mb.b > 200 && mb.r < 30, `só azul (r=${mb.r.toFixed(0)}, b=${mb.b.toFixed(0)})`);

  // Sem zoom, o estilo 'contain' continua mostrando a foto inteira.
  const c = join(dir, "c.jpg");
  assert.equal((await preparePhoto(photo, c, 400, 500, contain, undefined)).fit, "contain");
});

test("zoom fora da faixa é recusado com mensagem clara", async () => {
  const preset = await loadPreset(join(PRESETS_DIR, "limpo.json"));
  const base = { preset, platform: getPlatform("instagram_feed"), timing: { mode: "fixed" as const, total: 4 }, assets: ENGINE_ASSETS };
  for (const zoom of [0.5, 5]) {
    await assert.rejects(
      planRender({ ...base, items: [{ type: "photo", file: photo, zoom }] }),
      (e: unknown) => e instanceof EngineError && e.code === "invalid_item" && /zoom/.test(e.message),
    );
  }
  const ok = await planRender({ ...base, items: [{ type: "photo", file: photo, zoom: 2.5, focus: { x: 0.2, y: 0.5 } }] });
  assert.ok(ok.duration > 0);
});

test("perfil do feed do Instagram em 4:5", () => {
  const p = getPlatform("instagram_feed");
  assert.equal(p.width, 1080);
  assert.equal(p.height, 1350);
  assert.ok(listPlatforms().some((x) => x.id === "instagram_feed"));
});
