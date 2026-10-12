import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { rerankerInput, rerankerUpdate } from "@agentconnect/schemas/rerankers";
import { actor, workspaceAccess, params, id, audit } from "./app.js";
import { sql } from "./db.js";
import { HttpError } from "./http-error.js";
import { config } from "./config.js";
import { hosts } from "./knowledge-core.js";
import { validateEndpoint } from "@agentconnect/provider-sdk";
import type { AgentConfig } from "@agentconnect/schemas/agents";

export async function selectedReranker(
  rerankerId: string,
  workspaceId: string,
  organizationId: string,
) {
  const [r] =
    await sql`SELECT r.*,m.archived_at AS model_archived_at FROM rerankers r LEFT JOIN model_configurations m ON m.id=r.model_configuration_id WHERE r.id=${rerankerId} AND r.workspace_id=${workspaceId} AND r.organization_id=${organizationId} AND r.enabled AND r.archived_at IS NULL`;
  if (!r || (r.provider === "llm" && r.model_archived_at))
    throw new HttpError(
      409,
      "Selected reranker is unavailable. Choose another reranker and save the agent.",
    );
  return r;
}
export async function validateRerankerSelection(
  c: AgentConfig,
  workspaceId: string,
  organizationId: string,
) {
  if (!c.rag.rerank || !c.rag.rerankerId) return;
  const r = await selectedReranker(
    c.rag.rerankerId,
    workspaceId,
    organizationId,
  );
  if (r.provider === "llm") {
    const [m] =
      await sql`SELECT max_output_tokens,context_window FROM model_configurations WHERE id=${r.model_configuration_id}`;
    if (
      c.rag.rerankMaxOutputTokens > m!.max_output_tokens ||
      c.rag.rerankMaxOutputTokens >= m!.context_window
    )
      throw new HttpError(
        400,
        "Reranking output budget exceeds the selected model limits",
      );
  }
}
export async function registerRerankers(app: FastifyInstance) {
  const base = "/workspaces/:workspaceId/rerankers";
  app.get(base, async (r) => {
    const u = await actor(r),
      w = await workspaceAccess(u.id, id(params(r).workspaceId));
    return sql`SELECT r.id,r.name,r.provider,r.model_id,r.model_configuration_id,r.enabled,r.revision,(r.enabled AND (r.provider='cohere' OR m.archived_at IS NULL)) AS available FROM rerankers r LEFT JOIN model_configurations m ON m.id=r.model_configuration_id WHERE r.workspace_id=${w.id} AND r.archived_at IS NULL ORDER BY r.name`;
  });
  async function prepare(
    data: ReturnType<typeof rerankerInput.parse>,
    w: { id: string; organization_id: string },
  ) {
    if (data.provider === "llm") {
      const [m] =
        await sql`SELECT id FROM model_configurations WHERE id=${data.modelConfigurationId} AND workspace_id=${w.id} AND organization_id=${w.organization_id} AND archived_at IS NULL`;
      if (!m) throw new HttpError(400, "Select a model in this workspace");
    } else {
      validateEndpoint(
        data.baseUrl,
        hosts(config.RERANK_ALLOWED_HOSTS),
        hosts(config.MODEL_PRIVATE_HOSTS),
      );
      const u = new URL(data.baseUrl);
      if (u.search || u.hash || !["/", "/v2", "/v2/"].includes(u.pathname))
        throw new HttpError(400, "Use the Cohere instance root or /v2 URL");
      const [s] =
        await sql`SELECT id FROM secrets WHERE id=${data.secretId} AND workspace_id=${w.id} AND organization_id=${w.organization_id}`;
      if (!s) throw new HttpError(400, "Select a credential in this workspace");
    }
  }
  app.post(base, async (r, reply) => {
    const u = await actor(r),
      w = await workspaceAccess(
        u.id,
        id(params(r).workspaceId),
        "model:manage",
      ),
      data = rerankerInput.parse(r.body);
    await prepare(data, w);
    const rid = randomUUID();
    await sql.begin(async (tx) => {
      await tx`INSERT INTO rerankers(id,workspace_id,organization_id,name,provider,model_configuration_id,model_id,base_url,secret_id,enabled) VALUES(${rid},${w.id},${w.organization_id},${data.name},${data.provider},${data.provider === "llm" ? data.modelConfigurationId : null},${data.provider === "cohere" ? data.modelId : ""},${data.baseUrl},${data.provider === "cohere" ? data.secretId : null},${data.enabled})`;
      await audit(
        tx,
        r,
        u.id,
        "reranker.created",
        rid,
        w.organization_id,
        w.id,
      );
    });
    return reply.code(201).send({ id: rid, revision: 1 });
  });
  app.get(base + "/:rerankerId", async (r) => {
    const u = await actor(r),
      w = await workspaceAccess(
        u.id,
        id(params(r).workspaceId),
        "model:manage",
      );
    const [row] =
      await sql`SELECT * FROM rerankers WHERE id=${id(params(r).rerankerId)} AND workspace_id=${w.id} AND archived_at IS NULL`;
    if (!row) throw new HttpError(404, "Reranker unavailable");
    return row;
  });
  app.put(base + "/:rerankerId", async (r) => {
    const u = await actor(r),
      w = await workspaceAccess(
        u.id,
        id(params(r).workspaceId),
        "model:manage",
      ),
      data = rerankerUpdate.parse(r.body);
    await prepare(data, w);
    const rid = id(params(r).rerankerId);
    return sql.begin(async (tx) => {
      const [row] =
        await tx`UPDATE rerankers SET name=${data.name},provider=${data.provider},model_configuration_id=${data.provider === "llm" ? data.modelConfigurationId : null},model_id=${data.provider === "cohere" ? data.modelId : ""},base_url=${data.baseUrl},secret_id=${data.provider === "cohere" ? data.secretId : null},enabled=${data.enabled},revision=revision+1 WHERE id=${rid} AND workspace_id=${w.id} AND revision=${data.revision} AND archived_at IS NULL RETURNING revision`;
      if (!row)
        throw new HttpError(
          409,
          "Reranker changed or is unavailable; reload before saving",
        );
      await audit(
        tx,
        r,
        u.id,
        "reranker.updated",
        rid,
        w.organization_id,
        w.id,
      );
      return row;
    });
  });
  app.delete(base + "/:rerankerId", async (r) => {
    const u = await actor(r),
      w = await workspaceAccess(
        u.id,
        id(params(r).workspaceId),
        "model:manage",
      ),
      rid = id(params(r).rerankerId);
    await sql.begin(async (tx) => {
      const [row] =
        await tx`UPDATE rerankers SET archived_at=now(),enabled=false,revision=revision+1 WHERE id=${rid} AND workspace_id=${w.id} AND archived_at IS NULL RETURNING id`;
      if (!row) throw new HttpError(404, "Reranker unavailable");
      await audit(
        tx,
        r,
        u.id,
        "reranker.archived",
        rid,
        w.organization_id,
        w.id,
      );
    });
    return { ok: true };
  });
}
