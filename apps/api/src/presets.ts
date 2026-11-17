import { join } from "node:path";
import { listPresetFiles, loadPreset, mergePreset, parsePreset, type Preset } from "@video-editor/engine";
import { ApiError } from "./errors.js";
import type { VideoOptions } from "./options.js";

/** Biblioteca de presets: lê a pasta uma vez e guarda em memória (os arquivos vêm com o deploy). */
export class PresetLibrary {
  private cache = new Map<string, Preset>();
  private ids: string[] | undefined;

  constructor(private readonly dir: string) {}

  async list(): Promise<{ id: string; name: string; description?: string; version: number }[]> {
    this.ids ??= await listPresetFiles(this.dir);
    const out = [];
    for (const id of this.ids) {
      try {
        const p = await this.get(id);
        out.push({ id: p.id, name: p.name, description: p.description, version: p.version });
      } catch {
        // preset com erro não aparece na lista (o erro aparece ao pedi-lo)
      }
    }
    return out;
  }

  async get(id: string): Promise<Preset> {
    const hit = this.cache.get(id);
    if (hit) return hit;
    this.ids ??= await listPresetFiles(this.dir);
    if (!/^[a-z0-9-]+$/.test(id) || !this.ids.includes(id)) {
      throw new ApiError(404, "preset_not_found", `Preset "${id}" não existe`, { available: this.ids });
    }
    const preset = await loadPreset(join(this.dir, `${id}.json`), { presetsDir: this.dir });
    this.cache.set(id, preset);
    return preset;
  }
}

/**
 * Aplica os ajustes permitidos ao preset e valida de novo (mesmas faixas do schema).
 * Só os campos da lista branca de `options.overrides` chegam aqui.
 */
export function applyOverrides(base: Preset, overrides: VideoOptions["overrides"]): Preset {
  if (!overrides || Object.keys(overrides).length === 0) return base;
  const patch = structuredClone(overrides) as Record<string, unknown>;
  const merged = mergePreset(structuredClone(base), patch) as Record<string, unknown>;
  const t = merged.transition as Record<string, unknown> | undefined;
  // type e types são alternativos: o que veio no ajuste substitui o outro.
  if (t && overrides.transition?.type) delete t.types;
  if (t && overrides.transition?.types) delete t.type;
  try {
    return parsePreset(merged);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ApiError(422, "invalid_overrides", `Ajustes fora das faixas do preset: ${message}`);
  }
}
