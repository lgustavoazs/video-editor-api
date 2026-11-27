import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { clipVideoParts, displaySize, hdrToSdr, isHdr, resolveClipRange } from "../src/clip.js";
import { EngineError } from "../src/errors.js";
import { probeClip, runFfmpeg, type ClipInfo } from "../src/ffmpeg.js";
import { buildFiltergraph, type Segment } from "../src/filtergraph.js";
import { getPlatform } from "../src/platforms.js";
import { parsePreset } from "../src/preset.js";
import type { TextLayout } from "../src/text.js";
import { computeTiming, resolveAudioSegment } from "../src/timing.js";

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof EngineError, `esperava EngineError, veio ${String(err)}`);
    return err.code;
  }
  assert.fail("esperava erro");
}

const sdr: ClipInfo = {
  duration: 8, width: 1920, height: 1080, rotation: 0, sampleAspect: 1,
  hasAudio: true, codec: "h264", pixFmt: "yuv420p",
};
const base = { fps: 30, transition: 0.6, perPhotoMin: 1.5, perPhotoMax: 6, maxDuration: 60 };
const layout: TextLayout = { frameWidth: 1080, frameHeight: 1920, marginTop: 300, marginBottom: 700, marginSide: 90 };

test("trecho do clipe: padrões, duração, mm:ss e erros", () => {
  assert.deepEqual(resolveClipRange({}, 8, 0), { start: 0, length: 8 });
  assert.deepEqual(resolveClipRange({ start: 1, end: 5 }, 8, 0), { start: 1, length: 4 });
  assert.deepEqual(resolveClipRange({ start: "0:02", duration: 3 }, 8, 0), { start: 2, length: 3 });
  // fim arredondado para cima pelo cliente é aceito
  assert.equal(resolveClipRange({ start: 6, end: 8.03 }, 8, 0).length, 2);
  assert.equal(code(() => resolveClipRange({ end: 3, duration: 2 }, 8, 0)), "invalid_clip");
  assert.equal(code(() => resolveClipRange({ start: 9 }, 8, 0)), "clip_out_of_range");
  assert.equal(code(() => resolveClipRange({ start: 2, end: 9 }, 8, 0)), "clip_out_of_range");
  assert.equal(code(() => resolveClipRange({ start: 5, end: 4 }, 8, 0)), "invalid_clip");
  assert.equal(code(() => resolveClipRange({ start: 7.5 }, 8, 0)), "clip_too_short");
});

test("tamanho exibido considera rotação e proporção do pixel", () => {
  assert.deepEqual(displaySize(sdr), { width: 1920, height: 1080 });
  assert.deepEqual(displaySize({ ...sdr, rotation: 90 }), { width: 1080, height: 1920 });
  assert.deepEqual(displaySize({ ...sdr, rotation: 270 }), { width: 1080, height: 1920 });
  assert.deepEqual(displaySize({ ...sdr, width: 1440, sampleAspect: 4 / 3 }), { width: 1920, height: 1080 });
});

test("HDR: PQ e HLG são detectados; a conversão declara a cor de entrada em cada etapa", () => {
  assert.equal(isHdr(sdr), false);
  assert.equal(isHdr({ ...sdr, colorTransfer: "bt709" }), false);
  const pq = { ...sdr, colorTransfer: "smpte2084", colorPrimaries: "bt2020", colorSpace: "bt2020nc" };
  const hlg = { ...sdr, colorTransfer: "arib-std-b67" };
  assert.equal(isHdr(pq), true);
  assert.equal(isHdr(hlg), true);
  const chain = hdrToSdr(pq);
  assert.match(chain[0]!, /^zscale=tin=smpte2084:pin=bt2020:min=bt2020nc:t=linear/);
  assert.ok(chain.includes("tonemap=tonemap=mobius:desat=0"));
  assert.ok(chain.some((c) => c.startsWith("zscale=tin=linear:pin=bt2020:p=bt709")));
  // marcação ausente: assume BT.2020, que é o que celulares gravam em HDR
  assert.match(hdrToSdr(hlg)[0]!, /pin=bt2020:min=bt2020nc/);
});

test("ramo de vídeo do clipe: corte com foco, foto inteira sobre fundo desfocado ou cor", () => {
  const photo = parsePreset({
    id: "x", version: 1, name: "x", photo: {}, motion: { type: "none" },
    transition: { type: "fade", duration: 0.5 }, timing: { perPhotoMin: 1, perPhotoMax: 6 },
  }).photo;
  const cover = clipVideoParts(
    { index: 2, frames: 90, fit: "cover", focus: { x: 0.3, y: 0.5 }, hdr: false, info: sdr }, photo, 1080, 1920, 30,
  );
  assert.equal(cover.parts.length, 1);
  assert.match(cover.parts[0]!, /^\[2:v\]setpts=PTS-STARTPTS,fps=30,format=yuv420p,scale=1080:1920:force_original_aspect_ratio=increase/);
  assert.match(cover.parts[0]!, /0\.3\*iw-ow\/2/);

  const blur = clipVideoParts(
    { index: 1, frames: 90, fit: "contain", focus: { x: 0.5, y: 0.5 }, hdr: true, info: { ...sdr, colorTransfer: "smpte2084" } },
    photo, 1080, 1920, 30,
  );
  assert.equal(blur.parts.length, 4);
  assert.match(blur.parts[0]!, /^\[1:v\]zscale=tin=smpte2084/);
  assert.match(blur.parts[0]!, /split=2\[ca1\]\[cb1\]$/);
  assert.match(blur.parts[1]!, /gblur=sigma=/);
  assert.match(blur.parts[3]!, /overlay=\(W-w\)\/2:\(H-h\)\/2\[c1\]$/);

  const solid = clipVideoParts(
    { index: 0, frames: 90, fit: "contain", focus: { x: 0.5, y: 0.5 }, hdr: false, info: { ...sdr, sampleAspect: 4 / 3 } },
    { ...photo, background: { ...photo.background, type: "color", color: "#112233" } }, 1080, 1920, 30,
  );
  assert.equal(solid.parts.length, 1);
  assert.match(solid.parts[0]!, /scale=trunc\(iw\*sar\/2\)\*2:ih,setsar=1/);
  assert.match(solid.parts[0]!, /pad=1080:1920:\(ow-iw\)\/2:\(oh-ih\)\/2:color=0x112233/);
});

test("ramo de vídeo do clipe com zoom: recorta a área do formato do quadro, reduzida pelo zoom, e amplia", () => {
  const photo = parsePreset({
    id: "x", version: 1, name: "x", photo: {}, motion: { type: "none" },
    transition: { type: "fade", duration: 0.5 }, timing: { perPhotoMin: 1, perPhotoMax: 6 },
  }).photo;
  const z = clipVideoParts(
    { index: 0, frames: 60, fit: "cover", focus: { x: 0.8, y: 0.4 }, zoom: 2, hdr: false, info: sdr }, photo, 1080, 1350, 30,
  );
  assert.equal(z.parts.length, 1);
  assert.match(z.parts[0]!, /crop='trunc\(min\(iw,ih\*1080\/1350\)\/2\/2\)\*2':'trunc\(min\(ih,iw\*1350\/1080\)\/2\/2\)\*2'/);
  assert.match(z.parts[0]!, /0\.8\*iw-ow\/2/);
  assert.match(z.parts[0]!, /scale=1080:1350:flags=lanczos,setsar=1\[c0\]$/);
  // zoom 1 mantém o caminho original
  const z1 = clipVideoParts(
    { index: 0, frames: 60, fit: "cover", focus: { x: 0.5, y: 0.5 }, zoom: 1, hdr: false, info: sdr }, photo, 1080, 1350, 30,
  );
  assert.match(z1.parts[0]!, /force_original_aspect_ratio=increase/);
});

test("duração: clipes têm duração própria e as fotos dividem o resto", () => {
  // 3 fotos + clipes de 4 s e 3 s = 5 segmentos, 4 transições de 18 quadros, vídeo de 20 s
  const r = computeTiming({ ...base, photoCount: 3, mode: "fixed", requestedTotal: 20, clips: [4, 3] });
  assert.deepEqual(r.clipFrames, [120, 90]);
  assert.equal(r.total, 20);
  // (600 + 4·18 - 210) / 3 = 154 quadros por foto
  assert.deepEqual(r.photoFrames, [154, 154, 154]);
  const sum = 3 * 154 + 210 - 4 * r.transitionFrames;
  assert.equal(sum, r.totalFrames);
});

test("duração: o clipe não é esticado; quadro fracionário é arredondado para baixo", () => {
  const r = computeTiming({ ...base, photoCount: 1, mode: "fixed", requestedTotal: 10, clips: [3.99] });
  assert.deepEqual(r.clipFrames, [119]);
});

test("duração: só clipes define a duração; trecho de áudio curto falha sem loop", () => {
  const r = computeTiming({ ...base, photoCount: 0, mode: "fixed", requestedTotal: 30, clips: [4, 6, 3] });
  assert.equal(r.total, 11.8);
  assert.deepEqual(r.photoFrames, []);
  assert.equal(r.warnings.length, 1);

  const short = resolveAudioSegment({ start: 0, duration: 5 }, 60);
  assert.equal(
    code(() => computeTiming({ ...base, photoCount: 0, mode: "audio", segment: short, clips: [4, 6] })),
    "audio_segment_too_short",
  );
  const looped = computeTiming({ ...base, photoCount: 0, mode: "audio", segment: { ...short, loop: true }, clips: [4, 6] });
  assert.equal(looped.total, 9.4);
});

test("duração: erros de clipe curto, vídeo longo demais e falta de tempo para as fotos", () => {
  // com transição de 0,6 s o segmento precisa de 37 quadros (1,24 s)
  assert.equal(
    code(() => computeTiming({ ...base, photoCount: 1, mode: "fixed", requestedTotal: 8, clips: [1.1] })),
    "clip_too_short",
  );
  assert.equal(
    code(() => computeTiming({ ...base, maxDuration: 10, photoCount: 0, mode: "fixed", clips: [6, 6] })),
    "video_too_long",
  );
  try {
    computeTiming({ ...base, photoCount: 3, mode: "fixed", requestedTotal: 10, clips: [8] });
    assert.fail("esperava erro");
  } catch (err) {
    assert.ok(err instanceof EngineError);
    assert.equal(err.code, "too_many_photos");
    assert.match(err.message, /cartões e clipes ocupam 8\.00 s/);
  }
});

test("filtergraph: clipe com som entra na mixagem, abaixa a música e é cortado na contagem exata", () => {
  const preset = parsePreset({
    id: "x", version: 1, name: "x", photo: { fit: "cover" }, motion: { type: "none" },
    transition: { type: "fade", duration: 0.6 }, timing: { perPhotoMin: 1, perPhotoMax: 6 },
  });
  const segments: Segment[] = [
    { kind: "photo", frames: 100, zoomFrom: 1, zoomTo: 1, pan: "none", focus: { x: 0.5, y: 0.5 } },
    {
      kind: "clip", frames: 120, audio: { volume: 0.8 },
      video: { fit: "cover", focus: { x: 0.5, y: 0.5 }, hdr: false, info: sdr },
    },
    { kind: "photo", frames: 100, zoomFrom: 1, zoomTo: 1, pan: "none", focus: { x: 0.5, y: 0.5 } },
  ];
  const tf = 18;
  const totalFrames = 320 - 2 * tf;
  const g = buildFiltergraph({
    preset, platform: getPlatform("instagram_reels"), segments,
    transitions: ["fade", "fade"], transitionFrames: tf, total: totalFrames / 30,
    filterContext: { lutsDir: "/luts" }, fontsDir: "/fonts", layout,
    audio: { inputIndex: 3, start: 10, segmentLength: 20, loop: false },
  });
  // vídeo do clipe: sem zoompan, cortado em 120 quadros
  assert.equal((g.graph.match(/zoompan=/g) ?? []).length, 2);
  assert.match(g.graph, /tpad=stop_mode=clone:stop_duration=1,trim=end_frame=120,setpts=PTS-STARTPTS,fps=30\[v1\]/);
  // som do clipe: começa em (100 - 18) / 30 = 2,733 s
  assert.match(g.graph, /\[1:a\]atrim=end=4,.*volume=0\.8,.*adelay=delays=2733:all=1\[ac1\]/);
  // música abaixada para 0,35 dentro da janela do clipe (padrão do preset)
  assert.match(g.graph, /volume='1-0\.65\*min\(1,clip\(min\(\(t-2\.7333\)/);
  assert.match(g.graph, /\[amus\]\[ac1\]amix=inputs=2:duration=first:normalize=0/);
  assert.match(g.graph, /alimiter=limit=0\.97:level=false/);
  assert.equal(g.audioLabel, "aout");
});

test("filtergraph: sem música, o som do clipe entra sobre silêncio do tamanho do vídeo", () => {
  const preset = parsePreset({
    id: "x", version: 1, name: "x", photo: {}, motion: { type: "none" },
    transition: { type: "fade", duration: 0.5 }, timing: { perPhotoMin: 1, perPhotoMax: 6 },
  });
  const g = buildFiltergraph({
    preset, platform: getPlatform("tiktok"),
    segments: [{
      kind: "clip", frames: 90, audio: { volume: 1 },
      video: { fit: "cover", focus: { x: 0.5, y: 0.5 }, hdr: false, info: sdr },
    }],
    transitions: [], transitionFrames: 0, total: 3,
    filterContext: { lutsDir: "/luts" }, fontsDir: "/fonts", layout,
  });
  assert.match(g.graph, /anullsrc=r=48000:cl=stereo,atrim=end=3\[amus\]/);
  assert.doesNotMatch(g.graph, /adelay/);
  assert.equal(g.audioLabel, "aout");
});

test("sondagem real: rotação gravada pelo celular e marcação HDR", async () => {
  const dir = await mkdtemp(join(tmpdir(), "clipe-teste-"));
  try {
    const raw = join(dir, "raw.mp4");
    const rotated = join(dir, "rot.mp4");
    const ff = (args: string[]) => runFfmpeg(["-hide_banner", "-y", "-loglevel", "error", ...args]);
    await ff(["-f", "lavfi", "-i", "testsrc2=s=320x180:r=30:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", raw]);
    await ff(["-display_rotation:v:0", "-90", "-i", raw, "-c", "copy", rotated]);
    const info = await probeClip(rotated);
    assert.equal(info.rotation, 270);
    assert.deepEqual(displaySize(info), { width: 180, height: 320 });
    assert.equal(info.hasAudio, false);
    assert.ok(Math.abs(info.duration - 1) < 0.1);
    assert.equal(isHdr(info), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
