import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Db, KeyRow } from "./db.js";

const PREFIX = "vea_";

export function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/** Cria uma chave nova. O valor completo só é devolvido aqui; o banco guarda o hash. */
export function createKey(db: Db, name: string, now = Date.now()): { id: string; key: string; prefix: string } {
  const key = PREFIX + randomBytes(24).toString("base64url");
  const id = randomUUID();
  const prefix = key.slice(0, PREFIX.length + 6);
  db.insertKey({ id, name, hash: hashKey(key), prefix, created_at: now });
  return { id, key, prefix };
}

export function findActiveKey(db: Db, key: string): KeyRow | undefined {
  if (!key.startsWith(PREFIX) || key.length > 200) return undefined;
  const row = db.keyByHash(hashKey(key));
  return row && row.revoked_at === null ? row : undefined;
}

/** Comparação em tempo constante para a chave de administrador. */
export function sameSecret(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function publicKey(row: KeyRow) {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    createdAt: new Date(row.created_at).toISOString(),
    lastUsedAt: row.last_used_at ? new Date(row.last_used_at).toISOString() : null,
    revokedAt: row.revoked_at ? new Date(row.revoked_at).toISOString() : null,
  };
}

/** Limite simples por janela de 1 minuto, em memória (uma instância só). */
export class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(private readonly perMinute: number) {}

  /** Devolve 0 se liberado, ou os segundos até a próxima janela. */
  hit(id: string, now = Date.now()): number {
    if (this.perMinute <= 0) return 0;
    const w = this.windows.get(id);
    if (!w || now - w.start >= 60_000) {
      this.windows.set(id, { start: now, count: 1 });
      if (this.windows.size > 10_000) this.windows.clear();
      return 0;
    }
    if (w.count >= this.perMinute) return Math.ceil((w.start + 60_000 - now) / 1000);
    w.count++;
    return 0;
  }
}
