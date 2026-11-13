/**
 * Ferramenta de amostras: fotos + preset + trecho de áudio -> MP4.
 *
 * Exemplo:
 *   npm run sample -- --photos ./fotos --preset limpo --audio ./musica.mp3 --start 0:42.5 --end 1:12.5
 */
import { readdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { parseArgs } from "node:util";
import { EngineError } from "../errors.js";
import { getPlatform } from "../platforms.js";
import { loadPreset } from "../preset.js";
import { renderVideo } from "../render.js";
import { fromInvocationDir, OUT_DIR, PRESETS_DIR, TEST_ASSETS_DIR } from "./paths.js";

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

const HELP = `Uso: npm run sample -- [opções]

  --photos <pasta>      Pasta com as fotos (ordem alfabética). Padrão: assets/test
  --preset <id|arquivo> Preset da pasta presets/ ou caminho de um JSON. Padrão: limpo
  --platform <id>       Perfil de plataforma. Padrão: instagram_reels
  --audio <arquivo>     Faixa de áudio (opcional)
  --start <tempo>       Início do trecho (segundos ou mm:ss.mmm). Padrão: 0
  --end <tempo>         Fim do trecho
  --duration <tempo>    Duração do trecho (alternativa a --end)
  --mode <audio|fixed>  Padrão: audio se houver áudio, senão fixed
  --total <segundos>    Duração total no modo fixed
  --out <arquivo>       Saída. Padrão: out/amostra.mp4
  --x264-preset <nome>  Preset de velocidade do x264 (medium, fast, veryfast...)
`;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      photos: { type: "string" },
      preset: { type: "string", default: "limpo" },
      platform: { type: "string", default: "instagram_reels" },
      audio: { type: "string" },
      start: { type: "string" },
      end: { type: "string" },
      duration: { type: "string" },
      mode: { type: "string" },
      total: { type: "string" },
      out: { type: "string" },
      "x264-preset": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log(HELP);
    return;
  }

  const photosDir = values.photos ? fromInvocationDir(values.photos) : TEST_ASSETS_DIR;
  const entries = await readdir(photosDir).catch(() => {
    throw new EngineError("no_photos", `Pasta de fotos não encontrada: ${photosDir}`);
  });
  const photos = entries
    .filter((f) => IMAGE_EXTENSIONS.has(extname(f).toLowerCase()))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((f) => join(photosDir, f));
  if (photos.length === 0) throw new EngineError("no_photos", `Nenhuma foto em ${photosDir}`);

  const presetArg = values.preset!;
  const presetFile = presetArg.endsWith(".json")
    ? fromInvocationDir(presetArg)
    : join(PRESETS_DIR, `${presetArg}.json`);

  const mode = values.mode ?? (values.audio ? "audio" : "fixed");
  if (mode !== "audio" && mode !== "fixed") {
    throw new EngineError("invalid_mode", '--mode deve ser "audio" ou "fixed"');
  }

  const result = await renderVideo({
    photos,
    preset: await loadPreset(presetFile),
    platform: getPlatform(values.platform!),
    output: values.out ? fromInvocationDir(values.out) : join(OUT_DIR, "amostra.mp4"),
    timing: { mode, total: values.total ? Number(values.total) : undefined },
    audio: values.audio
      ? { file: fromInvocationDir(values.audio), start: values.start, end: values.end, duration: values.duration }
      : undefined,
    encode: { x264Preset: values["x264-preset"] },
  });

  console.log(JSON.stringify(result, null, 2));
}

main().catch((err: unknown) => {
  if (err instanceof EngineError) {
    console.error(`Erro [${err.code}]: ${err.message}`);
    if (Object.keys(err.details).length > 0) console.error(JSON.stringify(err.details, null, 2));
  } else {
    console.error(err);
  }
  process.exitCode = 1;
});
