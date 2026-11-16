import { spawn } from "node:child_process";
import { EngineError } from "./errors.js";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  wallSeconds: number;
}

const FFMPEG = process.env.FFMPEG_PATH ?? "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH ?? "ffprobe";

/**
 * Executa um binário com array de argumentos (nunca via shell),
 * para que nomes de arquivo e parâmetros não sejam interpretados.
 */
export function run(command: string, args: string[], timeoutMs = 10 * 60_000): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const started = process.hrtime.bigint();
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
      // mantém só o final do log, que é onde estão os erros e o resumo
      if (stderr.length > 200_000) stderr = stderr.slice(-100_000);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new EngineError("ffmpeg_not_found", `Não foi possível executar "${command}": ${err.message}`));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const wallSeconds = Number(process.hrtime.bigint() - started) / 1e9;
      if (signal === "SIGKILL") {
        reject(new EngineError("render_timeout", `"${command}" excedeu o tempo limite de ${timeoutMs / 1000} s`));
        return;
      }
      resolve({ code: code ?? -1, stdout, stderr, wallSeconds });
    });
  });
}

export function runFfmpeg(args: string[], timeoutMs?: number): Promise<RunResult> {
  return run(FFMPEG, args, timeoutMs);
}

export interface MediaInfo {
  duration: number;
  hasAudio: boolean;
  hasVideo: boolean;
  width?: number;
  height?: number;
  frameCount?: number;
}

export async function probe(file: string): Promise<MediaInfo> {
  const res = await run(FFPROBE, [
    "-v", "error",
    "-show_entries", "format=duration:stream=codec_type,width,height,nb_frames",
    "-of", "json",
    file,
  ]);
  if (res.code !== 0) {
    throw new EngineError("unreadable_media", `Arquivo de mídia ilegível: ${file}`, {
      stderr: res.stderr.slice(-500),
    });
  }
  const json = JSON.parse(res.stdout) as {
    format?: { duration?: string };
    streams?: { codec_type?: string; width?: number; height?: number; nb_frames?: string }[];
  };
  const streams = json.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video");
  const duration = Number(json.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new EngineError("unreadable_media", `Não foi possível obter a duração de: ${file}`);
  }
  return {
    duration,
    hasAudio: streams.some((s) => s.codec_type === "audio"),
    hasVideo: Boolean(video),
    width: video?.width,
    height: video?.height,
    frameCount: video?.nb_frames ? Number(video.nb_frames) : undefined,
  };
}

export interface BenchStats {
  /** Tempo de CPU em modo usuário (soma de todos os núcleos), em segundos. */
  cpuUserSeconds?: number;
  cpuSystemSeconds?: number;
  /** Pico de memória do processo do FFmpeg, em MB. */
  maxRssMb?: number;
}

/** Lê as linhas "bench:" que o FFmpeg imprime com a opção -benchmark. */
export function parseBench(stderr: string): BenchStats {
  const stats: BenchStats = {};
  const time = /bench: utime=([\d.]+)s stime=([\d.]+)s/.exec(stderr);
  if (time) {
    stats.cpuUserSeconds = Number(time[1]);
    stats.cpuSystemSeconds = Number(time[2]);
  }
  const rss = /bench: maxrss=(\d+)\s*(kB|KiB)/i.exec(stderr);
  if (rss) stats.maxRssMb = Math.round((Number(rss[1]) / 1024) * 10) / 10;
  return stats;
}

/**
 * Resume o erro do FFmpeg: ele repete o filtergraph inteiro na saída, o que esconde
 * a mensagem útil. Ficam só as linhas curtas, que são as de diagnóstico.
 */
export function summarizeFfmpegError(stderr: string): string {
  const lines = stderr
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && l.length <= 400 && !l.startsWith("bench:"));
  return lines.slice(-12).join("\n");
}
