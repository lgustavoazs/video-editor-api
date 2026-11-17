/**
 * Gera imagens, clipes e áudios sintéticos de teste em assets/test (fora do git).
 * Tamanhos e proporções variados de propósito, para exercitar o corte "cover",
 * o upscale de fotos pequenas, a rotação gravada por celulares e o HDR.
 */
import { access, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { availableFilters, runFfmpeg } from "../ffmpeg.js";
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

export interface TestClips {
  /** 1920x1080, H.264, 8 s, com som (bipes de 660 Hz, alto o bastante para medir na mixagem). */
  landscape: string;
  /** Gravado deitado (1920x1080) com rotação de 90°: exibido em pé, como fazem os celulares. 6 s, sem som. */
  rotated: string;
  /** HEVC 10 bits em HDR (BT.2020 + PQ), 6 s. Ausente se o FFmpeg não tiver libx265 ou zscale. */
  hdr?: string;
}

async function exists(file: string): Promise<boolean> {
  return access(file).then(
    () => true,
    () => false,
  );
}

async function makeClips(dir: string): Promise<TestClips> {
  const landscape = join(dir, "clipe-01-paisagem-som.mp4");
  if (!(await exists(landscape))) {
    await ffmpeg(
      [
        "-f", "lavfi", "-i", "testsrc2=s=1920x1080:r=30:d=8",
        "-f", "lavfi", "-i", "aevalsrc=0.7*sin(2*PI*660*t):d=8:s=48000",
        "-filter_complex", "[1:a]tremolo=f=1.5:d=0.9,volume=0.8[a]",
        "-map", "0:v", "-map", "[a]",
        "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
        landscape,
      ],
      "clipe em paisagem",
    );
  }

  const rotated = join(dir, "clipe-02-retrato-rotacao.mp4");
  if (!(await exists(rotated))) {
    const raw = join(dir, "clipe-02-tmp.mp4");
    // seta e texto indicam o lado de cima: no vídeo final eles devem aparecer de pé
    await ffmpeg(
      [
        "-f", "lavfi", "-i", "smptehdbars=s=1080x1920:r=30:d=6",
        "-vf", "drawbox=x=440:y=200:w=200:h=500:color=white:t=fill,transpose=2",
        "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
        raw,
      ],
      "clipe deitado",
    );
    await ffmpeg(["-display_rotation:v:0", "-90", "-i", raw, "-c", "copy", rotated], "rotação do clipe");
    await rm(raw, { force: true });
  }

  let hdr: string | undefined = join(dir, "clipe-03-hdr-pq.mp4");
  if (!(await exists(hdr))) {
    const filters = await availableFilters();
    const encoders = (await runFfmpeg(["-hide_banner", "-encoders"])).stdout;
    if (filters.has("zscale") && /\blibx265\b/.test(encoders)) {
      await ffmpeg(
        [
          "-f", "lavfi", "-i", "testsrc2=s=1920x1080:r=30:d=6",
          "-vf",
          // conversão direta de BT.709 para BT.2020 com PQ, numa etapa só
          "zscale=tin=bt709:pin=bt709:min=bt709:rin=tv:t=smpte2084:p=bt2020:m=bt2020nc:r=tv:npl=100,format=yuv420p10le",
          "-c:v", "libx265", "-preset", "fast",
          "-x265-params", "colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc:log-level=error",
          "-color_primaries", "bt2020", "-color_trc", "smpte2084", "-colorspace", "bt2020nc",
          "-tag:v", "hvc1",
          hdr,
        ],
        "clipe HDR",
      ).catch(async (err: unknown) => {
        await rm(hdr!, { force: true });
        throw err;
      });
    } else {
      hdr = undefined;
    }
  }
  return { landscape, rotated, hdr };
}

export async function makeTestAssets(
  dir = TEST_ASSETS_DIR,
): Promise<{ photos: string[]; clips: TestClips; tone: string; marker: string }> {
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

  const clips = await makeClips(dir);
  return { photos, clips, tone, marker };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const assets = await makeTestAssets();
  console.log(`Gerados em ${TEST_ASSETS_DIR}:`);
  const clips = Object.values(assets.clips).filter((c): c is string => Boolean(c));
  for (const p of [...assets.photos, ...clips, assets.tone, assets.marker]) console.log(`  ${p}`);
  if (!assets.clips.hdr) console.log("  (clipe HDR não gerado: o FFmpeg não tem libx265 ou zscale)");
}
