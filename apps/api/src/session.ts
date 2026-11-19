import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { ApiConfig } from "./config.js";
import type { KeyRow } from "./db.js";

/**
 * Sessão do site (uso próprio na V1): uma senha (`SITE_PASSWORD`) troca-se por um
 * cookie assinado, HttpOnly e SameSite=Strict. O navegador nunca vê chave de API.
 *
 * O segredo da assinatura deriva da senha e da ADMIN_KEY: trocar qualquer uma das
 * duas encerra todas as sessões abertas.
 */
export const SESSION_COOKIE = "vea_sessao";
const SESSION_DAYS = 30;

/** "Chave" interna dos pedidos feitos pelo site (não existe no banco). */
export const SITE_KEY: KeyRow = {
  id: "site",
  name: "site",
  hash: "",
  prefix: "site",
  created_at: 0,
  revoked_at: null,
  last_used_at: null,
  webhook_secret: null,
};

export function siteEnabled(cfg: ApiConfig): boolean {
  return Boolean(cfg.sitePassword && cfg.adminKey);
}

function secret(cfg: ApiConfig): Buffer {
  return createHash("sha256").update(`sessao|${cfg.adminKey ?? ""}|${cfg.sitePassword ?? ""}`).digest();
}

function mac(cfg: ApiConfig, payload: string): string {
  return createHmac("sha256", secret(cfg)).update(payload).digest("base64url");
}

export function issueSession(cfg: ApiConfig, now = Date.now()): { token: string; maxAge: number } {
  const maxAge = SESSION_DAYS * 24 * 3600;
  const exp = String(Math.floor(now / 1000) + maxAge);
  return { token: `${exp}.${mac(cfg, exp)}`, maxAge };
}

export function verifySession(cfg: ApiConfig, token: string | undefined, now = Date.now()): boolean {
  if (!siteEnabled(cfg) || !token) return false;
  const [exp, sig] = token.split(".");
  if (!exp || !sig || !/^\d{1,12}$/.test(exp)) return false;
  if (Number(exp) * 1000 < now) return false;
  const expected = Buffer.from(mac(cfg, exp));
  const given = Buffer.from(sig);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export function readCookie(req: FastifyRequest, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

export function hasSession(cfg: ApiConfig, req: FastifyRequest): boolean {
  return verifySession(cfg, readCookie(req, SESSION_COOKIE));
}

function cookieAttrs(req: FastifyRequest): string {
  // Secure só em https (na Railway o proxy informa o protocolo; em testes locais é http).
  return `Path=/; HttpOnly; SameSite=Strict${req.protocol === "https" ? "; Secure" : ""}`;
}

export function setSessionCookie(reply: FastifyReply, req: FastifyRequest, token: string, maxAge: number): void {
  void reply.header("set-cookie", `${SESSION_COOKIE}=${token}; Max-Age=${maxAge}; ${cookieAttrs(req)}`);
}

export function clearSessionCookie(reply: FastifyReply, req: FastifyRequest): void {
  void reply.header("set-cookie", `${SESSION_COOKIE}=; Max-Age=0; ${cookieAttrs(req)}`);
}
