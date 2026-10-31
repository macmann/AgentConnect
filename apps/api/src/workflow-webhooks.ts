import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { workflowJson } from "@agentconnect/schemas/workflow-values";
import { actionJsonSchema } from "@agentconnect/schemas/workflow-actions";
import { actor, workspaceAccess, audit, HttpError, id, params } from "./app.js";
import { sql } from "./db.js";
import { token, digest } from "./security.js";
import { config } from "./config.js";
import { redact } from "./tool-runtime.js";
import { schemaValidator } from "./workflow-action-schema.js";
import { storedWorkflowGraph } from "./workflow-v2.js";
import { workflowInputText } from "./workflow-triggers.js";
import { validateWorkflowDependencies } from "./workflow-runtime.js";
import { canonical } from "./workflow-action-runtime.js";
const webhookInput = z.strictObject({
  name: z.string().trim().min(1).max(100),
  versionId: z.uuid(),
  inputSchema: actionJsonSchema.default({ type: "object" }),
  sample: workflowJson.default({}),
  enabled: z.boolean().default(true),
  expiresInDays: z.number().int().min(1).max(365).default(90),
});
async function owned(
  r: FastifyRequest,
  capability: "workflow:manage" | "workflow:execute" | "workflow:read",
) {
  const u = await actor(r),
    [workflow] =
      await sql`SELECT * FROM workflows WHERE id=${id(params(r).workflowId)} AND archived_at IS NULL`;
  if (!workflow) throw new HttpError(404, "Workflow unavailable");
  await workspaceAccess(u.id, workflow.workspace_id, capability);
  return { u, workflow };
}
async function queueWebhook(
  row: Record<string, unknown>,
  body: unknown,
  r: FastifyRequest,
  userId: string,
  test = false,
) {
  const [version] =
    await sql`SELECT graph FROM workflow_versions WHERE id=${String(row.version_id)} AND workflow_id=${String(row.workflow_id)} AND workspace_id=${String(row.workspace_id)}`;
  if (!version) throw new HttpError(400, "Published workflow unavailable");
  const parsed = workflowJson.parse(body),
    validate = schemaValidator(row.input_schema as Record<string, unknown>);
  if (!validate(parsed))
    throw new HttpError(400, "Webhook payload does not match its schema");
  const payload = redact(parsed);
  if (!validate(payload))
    throw new HttpError(400, "Webhook payload cannot be retained safely");
  const graph = storedWorkflowGraph(version.graph);
  await validateWorkflowDependencies(
    graph,
    {
      workflowId: String(row.workflow_id),
      workspaceId: String(row.workspace_id),
      organizationId: String(row.organization_id),
      userId,
    },
    true,
  );
  if (graph.programV2)
    graph.programV2.trigger = {
      type: "webhook",
      webhookId: String(row.id),
      test,
      body: payload,
      query: workflowJson.parse(redact(r.query ?? {})),
      headers: { "content-type": "application/json" },
    } as never;
  const input = workflowInputText(
    graph,
    !graph.inputFields.length ? JSON.stringify(payload) : payload,
  );
  const key = !test
    ? z.string().min(1).max(128).optional().parse(r.headers["idempotency-key"])
    : undefined;
  const fingerprint = digest(
    canonical({
      versionId: row.version_id,
      payload,
      query: redact(r.query ?? {}),
    }),
  );
  return sql.begin(async (tx) => {
    const [live] =
      await tx`SELECT w.id FROM workflows w JOIN workflow_webhooks h ON h.workflow_id=w.id WHERE h.id=${String(row.id)} AND w.archived_at IS NULL AND (${test} OR (h.enabled AND h.expires_at>now() AND h.token_hash=${String(row.token_hash)} AND h.revision=${Number(row.revision)})) FOR UPDATE OF h`;
    if (!live) throw new HttpError(401, "Webhook is unavailable");
    if (key) {
      const [old] =
        await tx`SELECT id,status,request_fingerprint FROM workflow_runs WHERE webhook_id=${String(row.id)} AND idempotency_key=${key}`;
      if (old) {
        if (old.request_fingerprint !== fingerprint)
          throw new HttpError(
            409,
            "Idempotency key was used for different webhook input",
          );
        return { id: old.id, status: old.status, reused: true };
      }
    }
    const [count] =
      await tx`SELECT count(*)::int AS count FROM workflow_runs WHERE workspace_id=${String(row.workspace_id)} AND status IN ('queued','running','waiting')`;
    if (count!.count >= 20)
      throw new HttpError(429, "Workspace has too many active workflow runs");
    const runId = randomUUID();
    await tx`INSERT INTO workflow_runs(id,workflow_id,version_id,workspace_id,organization_id,user_id,graph_snapshot,input,status,webhook_id,idempotency_key,request_fingerprint) VALUES (${runId},${String(row.workflow_id)},${String(row.version_id)},${String(row.workspace_id)},${String(row.organization_id)},${userId},${tx.json(graph)},${input},'queued',${test ? null : String(row.id)},${key ?? null},${fingerprint})`;
    await audit(
      tx,
      r,
      userId,
      test ? "workflow.webhook_test_queued" : "workflow.webhook_queued",
      runId,
      String(row.organization_id),
      String(row.workspace_id),
    );
    return { id: runId, status: "queued", reused: false };
  });
}
export async function registerWorkflowWebhooks(app: FastifyInstance) {
  app.get("/workflows/:workflowId/webhooks", async (r) => {
    const { workflow: w } = await owned(r, "workflow:read");
    const rows =
      await sql`SELECT id,name,version_id,input_schema,sample,enabled,expires_at,revision FROM workflow_webhooks WHERE workflow_id=${w.id} ORDER BY created_at`;
    return rows.map((row) => ({
      ...row,
      endpoint: `/workflow-webhooks/${row.id}`,
    }));
  });
  app.post(
    "/workflows/:workflowId/webhooks",
    { bodyLimit: 40000 },
    async (r, reply) => {
      reply.header("Cache-Control", "no-store");
      const { u, workflow: w } = await owned(r, "workflow:manage");
      await workspaceAccess(u.id, w.workspace_id, "workflow:execute");
      const data = webhookInput.parse(r.body),
        validate = schemaValidator(data.inputSchema);
      if (!validate(data.sample) || !validate(redact(data.sample)))
        throw new HttpError(
          400,
          "Provide a safe request sample matching the schema",
        );
      const [version] =
        await sql`SELECT id FROM workflow_versions WHERE id=${data.versionId} AND workflow_id=${w.id}`;
      if (!version)
        throw new HttpError(400, "Choose a published workflow version");
      const webhookId = randomUUID(),
        secret = "acwh_" + token(),
        expiry = new Date(Date.now() + data.expiresInDays * 86400000);
      await sql.begin(async (tx) => {
        await tx`INSERT INTO workflow_webhooks(id,workflow_id,version_id,workspace_id,organization_id,name,token_hash,expires_at,input_schema,sample,enabled,created_by) VALUES (${webhookId},${w.id},${data.versionId},${w.workspace_id},${w.organization_id},${data.name},${digest(secret)},${expiry},${tx.json(data.inputSchema)},${tx.json(redact(data.sample) as never)},${data.enabled},${u.id})`;
        await audit(
          tx,
          r,
          u.id,
          "workflow.webhook_created",
          webhookId,
          w.organization_id,
          w.workspace_id,
        );
      });
      return reply.code(201).send({
        id: webhookId,
        endpoint: `/workflow-webhooks/${webhookId}`,
        token: secret,
        expiresAt: expiry,
        revision: 1,
      });
    },
  );
  app.put(
    "/workflows/:workflowId/webhooks/:webhookId",
    { bodyLimit: 40000 },
    async (r) => {
      const { u, workflow: w } = await owned(r, "workflow:manage"),
        data = webhookInput
          .safeExtend({ revision: z.number().int().min(1) })
          .parse(r.body);
      const validate = schemaValidator(data.inputSchema);
      if (!validate(data.sample) || !validate(redact(data.sample)))
        throw new HttpError(400, "Sample must match schema after redaction");
      const [version] =
        await sql`SELECT id FROM workflow_versions WHERE id=${data.versionId} AND workflow_id=${w.id}`;
      if (!version) throw new HttpError(400, "Published version unavailable");
      await sql.begin(async (tx) => {
        const saved =
          await tx`UPDATE workflow_webhooks SET name=${data.name},version_id=${data.versionId},input_schema=${tx.json(data.inputSchema)},sample=${tx.json(redact(data.sample) as never)},enabled=${data.enabled},expires_at=${new Date(Date.now() + data.expiresInDays * 86400000)},revision=revision+1 WHERE id=${id(params(r).webhookId)} AND workflow_id=${w.id} AND revision=${data.revision} RETURNING id`;
        if (!saved.length)
          throw new HttpError(409, "Webhook changed; reload before saving");
        await audit(
          tx,
          r,
          u.id,
          "workflow.webhook_updated",
          id(params(r).webhookId),
          w.organization_id,
          w.workspace_id,
        );
      });
      return { ok: true };
    },
  );
  app.post(
    "/workflows/:workflowId/webhooks/:webhookId/rotate",
    async (r, reply) => {
      reply.header("Cache-Control", "no-store");
      const { u, workflow: w } = await owned(r, "workflow:manage"),
        secret = "acwh_" + token();
      const row = await sql.begin(async (tx) => {
        const [changed] =
          await tx`UPDATE workflow_webhooks SET token_hash=${digest(secret)},revision=revision+1 WHERE id=${id(params(r).webhookId)} AND workflow_id=${w.id} RETURNING id,expires_at`;
        if (!changed) throw new HttpError(404, "Webhook unavailable");
        await audit(
          tx,
          r,
          u.id,
          "workflow.webhook_token_rotated",
          changed.id,
          w.organization_id,
          w.workspace_id,
        );
        return changed;
      });
      return { token: secret, expiresAt: row.expires_at };
    },
  );
  app.post(
    "/workflows/:workflowId/webhooks/:webhookId/test",
    { bodyLimit: 16000 },
    async (r, reply) => {
      const { u, workflow: w } = await owned(r, "workflow:execute"),
        [row] =
          await sql`SELECT * FROM workflow_webhooks WHERE id=${id(params(r).webhookId)} AND workflow_id=${w.id}`;
      if (!row) throw new HttpError(404, "Webhook unavailable");
      const data = z
        .strictObject({ input: workflowJson.optional() })
        .parse(r.body ?? {});
      return reply
        .code(202)
        .send(await queueWebhook(row, data.input ?? row.sample, r, u.id, true));
    },
  );
  app.post(
    "/workflow-webhooks/:webhookId",
    {
      bodyLimit: 16000,
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
    },
    async (r, reply) => {
      reply.header("Cache-Control", "no-store");
      const secret = r.headers.authorization?.match(
        /^Bearer (acwh_[a-f0-9]{64})$/,
      )?.[1];
      if (!secret)
        throw new HttpError(401, "A valid webhook bearer token is required");
      const [row] =
        await sql`SELECT h.* FROM workflow_webhooks h JOIN workflows w ON w.id=h.workflow_id JOIN users u ON u.id=h.created_by WHERE h.id=${id(params(r).webhookId)} AND h.token_hash=${digest(secret)} AND h.enabled AND h.expires_at>now() AND w.archived_at IS NULL AND (${!config.REQUIRE_EMAIL_VERIFICATION} OR u.verified_at IS NOT NULL)`;
      if (!row)
        throw new HttpError(401, "Webhook unavailable or token invalid");
      await workspaceAccess(
        row.created_by,
        row.workspace_id,
        "workflow:execute",
      );
      return reply
        .code(202)
        .send(await queueWebhook(row, r.body, r, row.created_by));
    },
  );
}
