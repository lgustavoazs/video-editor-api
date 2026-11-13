import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Raiz do repositório (vale tanto para src/cli quanto para dist/cli). */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
export const TEST_ASSETS_DIR = resolve(REPO_ROOT, "assets/test");
export const PRESETS_DIR = resolve(REPO_ROOT, "presets");
export const OUT_DIR = resolve(REPO_ROOT, "out");

/** Resolve caminhos relativos a partir de onde o usuário chamou o comando (npm muda o cwd). */
export function fromInvocationDir(path: string): string {
  return resolve(process.env.INIT_CWD ?? process.cwd(), path);
}
