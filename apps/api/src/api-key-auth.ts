import type { FastifyRequest } from "fastify";
import { sql } from "./db.js";
import { digest } from "./security.js";
import { HttpError } from "./http-error.js";
export function apiKeyChatRequest(r: FastifyRequest) {
  return (
    r.method === "POST" &&
    /^\/agents\/[0-9a-f-]{36}\/chat(?:\?.*)?$/.test(r.url) &&
    /^Bearer ac_/.test(r.headers.authorization ?? "")
  );
}
export async function apiKeyActor(r: FastifyRequest) {
  if (!apiKeyChatRequest(r)) throw new HttpError(401, "Sign in required");
  const raw = r.headers.authorization!.slice(7);
  if (raw.length > 200) throw new HttpError(401, "Invalid API key");
  const agentId = r.url.split("/")[2]!;
  const [key] =
    await sql`SELECT k.id,k.created_by FROM workspace_api_keys k JOIN agents a ON a.id=k.agent_id AND a.workspace_id=k.workspace_id AND a.organization_id=k.organization_id WHERE k.token_hash=${digest(raw)} AND k.agent_id=${agentId} AND k.revoked_at IS NULL AND k.expires_at>now() AND a.archived_at IS NULL`;
  if (!key)
    throw new HttpError(
      401,
      "API key expired, revoked, or outside its agent scope",
    );
  const [user] = await sql<
    { id: string; email: string; name: string; verified_at: Date | null }[]
  >`SELECT id,email,name,verified_at FROM users WHERE id=${key.created_by}`;
  if (!user) throw new HttpError(401, "API key issuer unavailable");
  await sql`UPDATE workspace_api_keys SET last_used_at=now() WHERE id=${key.id}`;
  return user;
}
