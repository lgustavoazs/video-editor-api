/**
 * Gera imagens e áudios sintéticos de teste em assets/test (fora do git).
 * Tamanhos e proporções variados de propósito, para exercitar o corte "cover"
 * e o upscale de fotos pequenas.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runFfmpeg } from "../ffmpeg.js";
import { TEST_ASSETS_DIR } from "./paths.js";

const GRID = "drawgrid=w=iw/10:h=iw/10:t=4:c=white@0.35";

const IMAGES: { name: string; source: string; filter?: string }[] = [
  { name: "01-paisagem-4000x3000.jpg", source: "testsrc2=s=4000x3000" },
  { name: "02-retrato-3000x4000.jpg", source: "mandelbrot=s=3000x4000:start_scale=1.5" },
  {
    name: "03-quadrada-3000x3000.jpg",
    source: "gradients=s=3000x3000:c0=0x1e3a8a:c1=0xf59e0b:x0=0:y0=0:x1=3000:y1=3000",
    filter: GRID,
  },
  { name: "04-paisagem-pequena-1280x720.jpg", source: "smptehdbars=s=1280x720" },
  {
    name: "05-retrato-pequeno-800x1200.jpg",
    source: "gradients=s=800x1200:c0=0x065f46:c1=0xfde68a:x0=0:y0=1200:x1=800:y1=0",
    filter: GRID,
  },
  { name: "06-retrato-2160x3840.jpg", source: "rgbtestsrc=s=2160x3840", filter: GRID },
];

async function ffmpeg(args: string[], what: string): Promise<void> {
  const res = await runFfmpeg(["-hide_banner", "-y", "-loglevel", "error", ...args]);
  if (res.code !== 0) throw new Error(`Falha ao gerar ${what}:\n${res.stderr}`);
}

export async function makeTestAssets(dir = TEST_ASSETS_DIR): Promise<{ photos: string[]; tone: string; marker: string }> {
  await mkdir(dir, { recursive: true });

  const photos: string[] = [];
  for (const img of IMAGES) {
    const file = join(dir, img.name);
    const args = ["-f", "lavfi", "-i", img.source];
    if (img.filter) args.push("-vf", img.filter);
    args.push("-frames:v", "1", "-q:v", "2", file);
    await ffmpeg(args, img.name);
    photos.push(file);
  }

  // Trilha de 45 s: acorde com pulsação, para ouvir fades e corte.
  const tone = join(dir, "tone.wav");
  await ffmpeg(
    [
      "-f", "lavfi", "-i", "sine=f=220:d=45:r=48000",
      "-f", "lavfi", "-i", "sine=f=277.18:d=45:r=48000",
      "-f", "lavfi", "-i", "sine=f=329.63:d=45:r=48000",
      "-filter_complex", "[0][1][2]amix=inputs=3:normalize=1,tremolo=f=2:d=0.6,volume=2",
      tone,
    ],
    "tone.wav",
  );

  // Marcador: silêncio absoluto até 10,000 s e tom de 880 Hz depois.
  // Serve para medir se o corte do trecho cai no ponto exato.
  const marker = join(dir, "marker.wav");
  await ffmpeg(
    ["-f", "lavfi", "-i", "aevalsrc='if(gte(t,10),0.5*sin(2*PI*880*t),0)':d=20:s=48000", marker],
    "marker.wav",
  );

  return { photos, tone, marker };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const assets = await makeTestAssets();
  console.log(`Gerados em ${TEST_ASSETS_DIR}:`);
  for (const p of [...assets.photos, assets.tone, assets.marker]) console.log(`  ${p}`);
}
