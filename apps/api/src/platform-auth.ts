import type { FastifyRequest } from "fastify";
import { sql } from "./db.js";
import { digest } from "./security.js";
import { workspaceAccess, HttpError } from "./app.js";
import { config } from "./config.js";
export type PlatformKey = {
  id: string;
  workspace_id: string;
  organization_id: string;
  created_by: string;
  agent_id: string | null;
  knowledge_base_id: string | null;
  scope: "agent:execute" | "agent:invoke" | "knowledge:search";
  details_enabled: boolean;
};
const principals = new WeakMap<FastifyRequest, PlatformKey>();
export function platformRequest(r: FastifyRequest) {
  const path = r.url.split("?")[0];
  return path === "/mcp" || path?.startsWith("/api/v1/") === true;
}
export const platformRateLimit = {
  max: 60,
  timeWindow: "1 minute",
  keyGenerator: (r: FastifyRequest) =>
    /^Bearer ac_/.test(r.headers.authorization ?? "")
      ? digest(r.headers.authorization!)
      : r.ip,
};
export async function platformKey(r: FastifyRequest): Promise<PlatformKey> {
  const cached = principals.get(r);
  if (cached) return cached;
  // Browser cookies never authorize integration requests.
  if (r.headers.origin && r.headers.origin !== config.WEB_ORIGIN)
    throw new HttpError(403, "Invalid integration origin");
  const header = r.headers.authorization ?? "";
  if (!/^Bearer ac_[A-Za-z0-9_-]+$/.test(header) || header.length > 207)
    throw new HttpError(401, "A scoped platform API key is required");
  const [key] = await sql<
    PlatformKey[]
  >`SELECT k.id,k.workspace_id,k.organization_id,k.created_by,k.agent_id,k.knowledge_base_id,k.scope,k.details_enabled FROM workspace_api_keys k JOIN users u ON u.id=k.created_by WHERE k.token_hash=${digest(header.slice(7))} AND k.revoked_at IS NULL AND k.expires_at>now() AND (${!config.REQUIRE_EMAIL_VERIFICATION} OR u.verified_at IS NOT NULL)`;
  if (!key) throw new HttpError(401, "API key expired, revoked or unavailable");
  await workspaceAccess(
    key.created_by,
    key.workspace_id,
    key.agent_id ? "agent:execute" : "knowledge:read",
  );
  const rows = key.agent_id
    ? await sql`SELECT id FROM agents WHERE id=${key.agent_id} AND workspace_id=${key.workspace_id} AND organization_id=${key.organization_id} AND archived_at IS NULL`
    : await sql`SELECT id FROM knowledge_bases WHERE id=${key.knowledge_base_id!} AND workspace_id=${key.workspace_id} AND organization_id=${key.organization_id} AND archived_at IS NULL`;
  if (!rows.length) throw new HttpError(404, "Scoped resource unavailable");
  await sql`UPDATE workspace_api_keys SET last_used_at=now() WHERE id=${key.id}`;
  principals.set(r, key);
  return key;
}
export function requirePlatformScope(
  key: PlatformKey,
  scope: "agent:execute" | "knowledge:search",
  resourceId: string,
  details = false,
) {
  if (
    !(
      key.scope === scope ||
      (scope === "agent:execute" && key.scope === "agent:invoke")
    ) ||
    (scope === "agent:execute" ? key.agent_id : key.knowledge_base_id) !==
      resourceId
  )
    throw new HttpError(403, "Resource is outside this API key’s scope");
  if (details && !key.details_enabled)
    throw new HttpError(
      403,
      "Execution details are not enabled for this API key",
    );
}
