/**
 * Ferramenta de amostras: itens + preset + trecho de áudio + logos -> MP4.
 *
 * Uso rápido (pasta de fotos, em ordem alfabética):
 *   npm run sample -- --photos ./fotos --preset limpo --audio ./musica.mp3 --start 0:32 --end 0:56 \
 *       --logo-brand ./logo.png --title "Copa Masters"
 *
 * Uso completo (arquivo no mesmo formato do campo "options" da API):
 *   npm run sample -- --request ./pedido.json
 */
import { readdir, readFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { EngineError } from "../errors.js";
import { getPlatform } from "../platforms.js";
import { loadPreset, type LogoRole } from "../preset.js";
import { renderVideo, type RenderItem, type RenderRequest } from "../render.js";
import { ENGINE_ASSETS, fromInvocationDir, OUT_DIR, PRESETS_DIR, TEST_ASSETS_DIR } from "./paths.js";

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

const HELP = `Uso: npm run sample -- [opções]

  --request <arquivo>    Pedido completo em JSON (itens com foco e legenda, logos, título...).
                         Caminhos de arquivo são relativos à pasta do JSON.
                         As opções abaixo valem quando --request não é usado.

  --photos <pasta>       Pasta com as fotos (ordem alfabética). Padrão: assets/test
  --preset <id|arquivo>  Preset da pasta presets/ ou caminho de um JSON. Padrão: limpo
  --platform <id>        Perfil de plataforma. Padrão: instagram_reels
  --audio <arquivo>      Faixa de áudio (opcional)
  --start <tempo>        Início do trecho (segundos ou mm:ss.mmm). Padrão: 0
  --end <tempo>          Fim do trecho
  --duration <tempo>     Duração do trecho (alternativa a --end)
  --loop                 Repete o trecho se o vídeo for mais longo que ele
  --mode <audio|fixed>   Padrão: audio se houver áudio, senão fixed
  --total <segundos>     Duração total no modo fixed
  --logo-brand <arquivo>   Logo da marca
  --logo-partner <arquivo> Logo do parceiro/patrocinador
  --title <texto>        Título (se o preset tiver estilo de título)
  --out <arquivo>        Saída. Padrão: out/amostra.mp4
  --x264-preset <nome>   Preset de velocidade do x264 (medium, fast, veryfast...)
`;

interface RequestFile {
  preset?: string;
  platform?: string;
  timing?: { mode?: "audio" | "fixed"; total?: number };
  items?: { type?: "photo" | "clip"; file: string; focus?: { x: number; y: number }; caption?: string }[];
  audio?: { file: string; start?: number | string; end?: number | string; duration?: number | string; loop?: boolean };
  logos?: { role: LogoRole; file: string }[];
  title?: string;
  out?: string;
}

function presetPath(arg: string, baseDir: string): string {
  if (!arg.endsWith(".json")) return join(PRESETS_DIR, `${arg}.json`);
  return isAbsolute(arg) ? arg : resolve(baseDir, arg);
}

async function photosFromDir(dir: string): Promise<RenderItem[]> {
  const entries = await readdir(dir).catch(() => {
    throw new EngineError("no_photos", `Pasta de fotos não encontrada: ${dir}`);
  });
  const items = entries
    .filter((f) => IMAGE_EXTENSIONS.has(extname(f).toLowerCase()))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((f): RenderItem => ({ type: "photo", file: join(dir, f) }));
  if (items.length === 0) throw new EngineError("no_photos", `Nenhuma foto em ${dir}`);
  return items;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      request: { type: "string" },
      photos: { type: "string" },
      preset: { type: "string" },
      platform: { type: "string" },
      audio: { type: "string" },
      start: { type: "string" },
      end: { type: "string" },
      duration: { type: "string" },
      loop: { type: "boolean" },
      mode: { type: "string" },
      total: { type: "string" },
      "logo-brand": { type: "string" },
      "logo-partner": { type: "string" },
      title: { type: "string" },
      out: { type: "string" },
      "x264-preset": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log(HELP);
    return;
  }

  let request: RenderRequest;
  const encode = { x264Preset: values["x264-preset"] };

  if (values.request) {
    const file = fromInvocationDir(values.request);
    const base = dirname(file);
    const rel = (p: string) => (isAbsolute(p) ? p : resolve(base, p));
    let json: RequestFile;
    try {
      json = JSON.parse(await readFile(file, "utf8")) as RequestFile;
    } catch (err) {
      throw new EngineError("invalid_request", `Não foi possível ler o pedido "${file}": ${(err as Error).message}`);
    }
    if (!Array.isArray(json.items) || json.items.length === 0) {
      throw new EngineError("no_photos", 'O pedido precisa de uma lista "items"');
    }
    request = {
      items: json.items.map((i) => ({ type: i.type ?? "photo", file: rel(i.file), focus: i.focus, caption: i.caption })),
      preset: await loadPreset(presetPath(json.preset ?? "limpo", base), { presetsDir: PRESETS_DIR }),
      platform: getPlatform(json.platform ?? "instagram_reels"),
      output: values.out ? fromInvocationDir(values.out) : json.out ? rel(json.out) : join(OUT_DIR, "amostra.mp4"),
      timing: { mode: json.timing?.mode ?? (json.audio ? "audio" : "fixed"), total: json.timing?.total },
      audio: json.audio ? { ...json.audio, file: rel(json.audio.file) } : undefined,
      logos: json.logos?.map((l) => ({ role: l.role, file: rel(l.file) })),
      title: json.title,
      assets: ENGINE_ASSETS,
      encode,
    };
  } else {
    const mode = values.mode ?? (values.audio ? "audio" : "fixed");
    if (mode !== "audio" && mode !== "fixed") {
      throw new EngineError("invalid_mode", '--mode deve ser "audio" ou "fixed"');
    }
    const logos: { role: LogoRole; file: string }[] = [];
    if (values["logo-brand"]) logos.push({ role: "brand", file: fromInvocationDir(values["logo-brand"]) });
    if (values["logo-partner"]) logos.push({ role: "partner", file: fromInvocationDir(values["logo-partner"]) });
    const invocationDir = process.env.INIT_CWD ?? process.cwd();
    request = {
      items: await photosFromDir(values.photos ? fromInvocationDir(values.photos) : TEST_ASSETS_DIR),
      preset: await loadPreset(presetPath(values.preset ?? "limpo", invocationDir), { presetsDir: PRESETS_DIR }),
      platform: getPlatform(values.platform ?? "instagram_reels"),
      output: values.out ? fromInvocationDir(values.out) : join(OUT_DIR, "amostra.mp4"),
      timing: { mode, total: values.total ? Number(values.total) : undefined },
      audio: values.audio
        ? {
            file: fromInvocationDir(values.audio),
            start: values.start,
            end: values.end,
            duration: values.duration,
            loop: values.loop,
          }
        : undefined,
      logos,
      title: values.title,
      assets: ENGINE_ASSETS,
      encode,
    };
  }

  const result = await renderVideo(request);
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
