import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type JobStatus = "queued" | "processing" | "done" | "failed" | "expired" | "canceled" | "deleted";

export interface JobRow {
  id: string;
  key_id: string;
  status: JobStatus;
  progress: number;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  expires_at: number | null;
  /** Pedido já resolvido (caminhos locais), em JSON. */
  request_json: string;
  result_json: string | null;
  error_json: string | null;
  warnings_json: string;
  callback_url: string | null;
  output_bytes: number | null;
}

export interface KeyRow {
  id: string;
  name: string;
  hash: string;
  prefix: string;
  created_at: number;
  revoked_at: number | null;
  last_used_at: number | null;
}

/** Banco SQLite do serviço (chaves e pedidos). Um arquivo só, dentro de DATA_DIR. */
export class Db {
  readonly sql: DatabaseSync;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.sql = new DatabaseSync(join(dataDir, "api.sqlite"));
    this.sql.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        hash TEXT NOT NULL UNIQUE,
        prefix TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        revoked_at INTEGER,
        last_used_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        key_id TEXT NOT NULL,
        status TEXT NOT NULL,
        progress REAL NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        finished_at INTEGER,
        expires_at INTEGER,
        request_json TEXT NOT NULL,
        result_json TEXT,
        error_json TEXT,
        warnings_json TEXT NOT NULL DEFAULT '[]',
        callback_url TEXT,
        output_bytes INTEGER
      );
      CREATE INDEX IF NOT EXISTS jobs_status ON jobs (status, created_at);
      CREATE INDEX IF NOT EXISTS jobs_key ON jobs (key_id, created_at);
    `);
  }

  close(): void {
    this.sql.close();
  }

  // ---- chaves ----

  insertKey(row: Omit<KeyRow, "revoked_at" | "last_used_at">): void {
    this.sql
      .prepare("INSERT INTO api_keys (id, name, hash, prefix, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(row.id, row.name, row.hash, row.prefix, row.created_at);
  }

  keyByHash(hash: string): KeyRow | undefined {
    return this.sql.prepare("SELECT * FROM api_keys WHERE hash = ?").get(hash) as KeyRow | undefined;
  }

  listKeys(): KeyRow[] {
    return this.sql.prepare("SELECT * FROM api_keys ORDER BY created_at").all() as unknown as KeyRow[];
  }

  revokeKey(id: string, now: number): boolean {
    const r = this.sql.prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(now, id);
    return Number(r.changes) > 0;
  }

  touchKey(id: string, now: number): void {
    this.sql.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").run(now, id);
  }

  // ---- pedidos ----

  insertJob(row: Pick<JobRow, "id" | "key_id" | "created_at" | "request_json" | "warnings_json" | "callback_url">): void {
    this.sql
      .prepare(
        "INSERT INTO jobs (id, key_id, status, created_at, request_json, warnings_json, callback_url) VALUES (?, ?, 'queued', ?, ?, ?, ?)",
      )
      .run(row.id, row.key_id, row.created_at, row.request_json, row.warnings_json, row.callback_url);
  }

  job(id: string): JobRow | undefined {
    return this.sql.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as JobRow | undefined;
  }

  jobsByStatus(status: JobStatus): JobRow[] {
    return this.sql
      .prepare("SELECT * FROM jobs WHERE status = ? ORDER BY created_at, rowid")
      .all(status) as unknown as JobRow[];
  }

  countByStatus(): Record<string, number> {
    const rows = this.sql.prepare("SELECT status, COUNT(*) AS n FROM jobs GROUP BY status").all() as {
      status: string;
      n: number;
    }[];
    return Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
  }

  update(id: string, fields: Partial<Omit<JobRow, "id">>): void {
    const keys = Object.keys(fields) as (keyof typeof fields)[];
    if (keys.length === 0) return;
    const set = keys.map((k) => `${k} = ?`).join(", ");
    const values = keys.map((k) => (fields[k] === undefined ? null : fields[k])) as (string | number | null)[];
    this.sql.prepare(`UPDATE jobs SET ${set} WHERE id = ?`).run(...values, id);
  }

  /** Pedidos prontos cujo prazo venceu. */
  expiredJobs(now: number): JobRow[] {
    return this.sql
      .prepare("SELECT * FROM jobs WHERE status = 'done' AND expires_at IS NOT NULL AND expires_at <= ?")
      .all(now) as unknown as JobRow[];
  }

  /** Remove do banco registros finalizados há mais de `olderThan` ms (mantém o histórico enxuto). */
  purgeOld(before: number): number {
    const r = this.sql
      .prepare("DELETE FROM jobs WHERE status IN ('failed','expired','canceled','deleted') AND COALESCE(finished_at, created_at) < ?")
      .run(before);
    return Number(r.changes);
  }
}
