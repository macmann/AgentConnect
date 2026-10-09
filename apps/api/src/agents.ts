import {
  modelSnapshotSchema,
  connection,
  validateAgentModel,
  type ModelSnapshot,
} from "./agent-models.js";
import { validateToolIds, runAgentTools, ToolError } from "./tool-runtime.js";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { trace, SpanStatusCode } from "@opentelemetry/api";
import {
  modelInput,
  agentInput,
  agentUpdate,
  agentConfig,
  publishInput,
  deploymentInput,
  chatInput,
  type AgentConfig,
} from "@agentconnect/schemas/agents";
import {
  createProvider,
  safeTransport,
  defaultBaseUrls,
  validateEndpoint,
  ProviderError,
  type ProviderFactory,
  type ModelConnection,
  type ChatMessage,
} from "@agentconnect/provider-sdk";
import { PostgresRagTool, validateKnowledgeIds } from "./knowledge-core.js";
import {
  groundedPrompt,
  citedSources,
  type Citation,
  type RagTool,
} from "@agentconnect/rag/tool";
import { KnowledgeError } from "@agentconnect/rag/parsers";
import type { EmbeddingFactory } from "@agentconnect/provider-sdk/embeddings";
import { SingleAgentRuntime } from "@agentconnect/agent-sdk";
import { actor, workspaceAccess, audit, HttpError, id, params } from "./app.js";
import { sql } from "./db.js";
import { token, digest } from "./security.js";
import { config } from "./config.js";
const allowedHosts = () =>
  config.MODEL_ALLOWED_HOSTS.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
const privateHosts = () =>
  config.MODEL_PRIVATE_HOSTS.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
type AgentRow = {
  id: string;
  organization_id: string;
  workspace_id: string;
  name: string;
  description: string;
  public_description: string;
  draft_config: AgentConfig;
  revision: number;
  archived_at: Date | null;
};
type ConversationRow = {
  id: string;
  organization_id: string;
  workspace_id: string;
  agent_id: string;
  deployment_id: string | null;
  version_id: string | null;
  user_id: string | null;
  guest_token_hash: string | null;
  config_snapshot: AgentConfig;
  model_snapshot: ModelSnapshot;
};
const runtime = new SingleAgentRuntime();
async function modelSnapshot(modelId: string, workspaceId: string) {
  const [m] =
    await sql`SELECT id,provider,model_id,base_url,secret_id,capabilities,context_window,max_output_tokens FROM model_configurations WHERE id=${modelId} AND workspace_id=${workspaceId}`;
  if (!m) throw new HttpError(400, "Select a model from this workspace");
  return modelSnapshotSchema.parse({
    id: m.id,
    provider: m.provider,
    modelId: m.model_id,
    baseUrl: m.base_url,
    secretId: m.secret_id,
    capabilities: m.capabilities,
    contextWindow: m.context_window,
    maxOutputTokens: m.max_output_tokens,
  });
}
async function ownedAgent(
  r: FastifyRequest,
  cap?: Parameters<typeof workspaceAccess>[2],
) {
  const u = await actor(r);
  const [a] = await sql<
    AgentRow[]
  >`SELECT * FROM agents WHERE id=${id(params(r).agentId)} AND archived_at IS NULL`;
  if (!a) throw new HttpError(404, "Agent not found");
  const w = await workspaceAccess(u.id, a.workspace_id, cap);
  return { u, a, w };
}
function equalToken(candidate: string, hash: string) {
  const a = Buffer.from(digest(candidate));
  const b = Buffer.from(hash);
  return a.length === b.length && timingSafeEqual(a, b);
}
async function publicDeployment(deploymentId: string) {
  const [d] =
    await sql`SELECT d.id,d.agent_id,d.workspace_id,d.organization_id,d.version_id,v.name,v.public_description,v.config,v.model_snapshot FROM deployments d JOIN agent_versions v ON v.id=d.version_id JOIN agents a ON a.id=d.agent_id WHERE d.id=${deploymentId} AND d.enabled=true AND a.archived_at IS NULL`;
  if (!d) throw new HttpError(404, "Deployment unavailable");
  return d;
}
async function streamChat(
  r: FastifyRequest,
  reply: FastifyReply,
  conversation: ConversationRow,
  message: string,
  factory: ProviderFactory,
  guestToken?: string,
  ragTool: RagTool = new PostgresRagTool(),
) {
  const c = agentConfig.parse(conversation.config_snapshot);
  const model = modelSnapshotSchema.parse(conversation.model_snapshot);
  validateAgentModel(c, model);
  const provider = factory(
    await connection(
      model,
      conversation.workspace_id,
      conversation.organization_id,
    ),
  );
  const runId = randomUUID();
  const span = trace.getTracer("agentconnect-runtime").startSpan("agent.run", {
    attributes: {
      "run.id": runId,
      "conversation.id": conversation.id,
      "agent.id": conversation.agent_id,
      "agent.version": conversation.version_id ?? "draft",
      "organization.id": conversation.organization_id,
      "workspace.id": conversation.workspace_id,
      "user.id": conversation.user_id ?? "anonymous",
      "model.provider": model.provider,
      "model.id": model.modelId,
    },
  });
  const traceId =
    span.spanContext().traceId === "00000000000000000000000000000000"
      ? randomUUID().replaceAll("-", "")
      : span.spanContext().traceId;
  try {
    await sql.begin(async (tx) => {
      await tx`INSERT INTO agent_runs(id,conversation_id,organization_id,workspace_id,status,trace_id) VALUES (${runId},${conversation.id},${conversation.organization_id},${conversation.workspace_id},'running',${traceId})`;
      await tx`INSERT INTO messages(id,conversation_id,organization_id,workspace_id,run_id,role,content) VALUES (${randomUUID()},${conversation.id},${conversation.organization_id},${conversation.workspace_id},${runId},'user',${message})`;
    });
  } catch (e) {
    span.end();
    if ((e as { code?: string }).code === "23505")
      throw new HttpError(
        409,
        "A response is already running in this conversation",
      );
    throw e;
  }
  const rows = await sql<
    { role: "user" | "assistant"; content: string }[]
  >`SELECT m.role,m.content FROM messages m JOIN agent_runs ar ON ar.id=m.run_id WHERE m.conversation_id=${conversation.id} AND (ar.status='completed' OR ar.id=${runId}) ORDER BY m.created_at DESC,m.id DESC LIMIT ${c.historyWindow * 2}`;
  const messages: ChatMessage[] = rows.reverse();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90000);
  timer.unref();
  reply.hijack();
  const responseHeaders: Record<string, string | number | string[]> = {};
  for (const [name, value] of Object.entries(reply.getHeaders())) {
    if (typeof value === "string" || typeof value === "number")
      responseHeaders[name] = value;
    else if (Array.isArray(value)) responseHeaders[name] = value.map(String);
  }
  reply.raw.writeHead(200, {
    ...responseHeaders,
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Accel-Buffering": "no",
    Connection: "keep-alive",
  });
  const write = (event: string, data: unknown) => {
    if (!reply.raw.destroyed)
      reply.raw.write(
        `event: ${event}\ndata: ${JSON.stringify({ protocolVersion: 1, ...(data as object) })}\n\n`,
      );
  };
  const disconnected = () => {
    if (!reply.raw.writableEnded) controller.abort();
  };
  reply.raw.on("close", disconnected);
  const heartbeat = setInterval(() => {
    if (!reply.raw.destroyed) reply.raw.write(": heartbeat\n\n");
  }, 15000);
  heartbeat.unref();
  write("meta", {
    runId,
    traceId,
    conversationId: conversation.id,
    ...(guestToken ? { guestToken } : {}),
  });
  let output = "";
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  let status = "completed";
  let errorCode: string | null = null;
  let sources: Citation[] = [];
  let citations: Citation[] = [];
  let retrievalMs: number | null = null;
  try {
    if (c.rag.knowledgeBaseIds.length) {
      const started = performance.now();
      sources = await ragTool.execute(
        message,
        c.rag.knowledgeBaseIds,
        c.rag,
        {
          workspaceId: conversation.workspace_id,
          organizationId: conversation.organization_id,
          publicAccess: !!conversation.deployment_id,
        },
        controller.signal,
      );
      retrievalMs = Math.round(performance.now() - started);
      if (!sources.length) throw new KnowledgeError("NO_RELEVANT_SOURCES");
      write("sources", { sources });
    }
    const toolsResult = await runAgentTools(
      c,
      provider,
      message,
      {
        workspaceId: conversation.workspace_id,
        organizationId: conversation.organization_id,
        publicAccess: !!conversation.deployment_id,
        userId: conversation.user_id ?? undefined,
        runId,
      },
      controller.signal,
      (data) => write("tool", data),
      model.contextWindow - c.maxOutputTokens,
    );
    const grounding =
      (sources.length ? groundedPrompt(sources) : "") + toolsResult.grounding;
    // Conservative UTF-8 byte budget avoids sending an oversized context to providers.
    if (
      Buffer.byteLength(JSON.stringify(messages)) +
        Buffer.byteLength(JSON.stringify(c.prompt)) +
        Buffer.byteLength(grounding) >
      model.contextWindow - c.maxOutputTokens
    )
      throw new ProviderError("CONTEXT_LIMIT");
    for await (const event of runtime.run(
      c,
      messages,
      provider,
      controller.signal,
      grounding,
    )) {
      if (controller.signal.aborted) throw new ProviderError("CANCELLED");
      if (event.type === "token") {
        output += event.text;
        if (output.length > 256000) throw new ProviderError("OUTPUT_LIMIT");
        write("token", { text: event.text });
      } else {
        inputTokens =
          event.inputTokens === null || toolsResult.inputTokens === null
            ? null
            : event.inputTokens + toolsResult.inputTokens;
        outputTokens =
          event.outputTokens === null || toolsResult.outputTokens === null
            ? null
            : event.outputTokens + toolsResult.outputTokens;
      }
    }
    citations = citedSources(output, sources);
    if (sources.length && c.rag.requireCitations && !citations.length)
      throw new KnowledgeError("CITATION_REQUIRED");
    if (
      sources.length &&
      [...output.matchAll(/\[(\d+)\]/g)].some(
        (m) => !sources.some((s) => s.id === Number(m[1])),
      )
    )
      throw new KnowledgeError("INVALID_CITATION");
  } catch (e) {
    citations = citedSources(output, sources);
    status = controller.signal.aborted ? "cancelled" : "failed";
    errorCode = controller.signal.aborted
      ? "CANCELLED"
      : e instanceof ProviderError ||
          e instanceof KnowledgeError ||
          e instanceof ToolError
        ? e.code
        : "RUNTIME_ERROR";
    span.setStatus({ code: SpanStatusCode.ERROR, message: errorCode });
  } finally {
    clearTimeout(timer);
    clearInterval(heartbeat);
    reply.raw.off("close", disconnected);
    try {
      await sql.begin(async (tx) => {
        if (output)
          await tx`INSERT INTO messages(id,conversation_id,organization_id,workspace_id,run_id,role,content,citations) VALUES (${randomUUID()},${conversation.id},${conversation.organization_id},${conversation.workspace_id},${runId},'assistant',${output},${tx.json(citations.map((s) => ({ ...s })))})`;
        await tx`UPDATE agent_runs SET status=${status},input_tokens=${inputTokens},output_tokens=${outputTokens},error_code=${errorCode},finished_at=now(),retrieval=${tx.json(sources.map((s) => ({ ...s })))},retrieval_ms=${retrievalMs} WHERE id=${runId}`;
      });
      if (errorCode)
        write("error", {
          code: errorCode,
          message:
            errorCode === "NO_RELEVANT_SOURCES"
              ? "No relevant knowledge was found. Try another question or check the knowledge sources."
              : errorCode === "CITATION_REQUIRED" ||
                  errorCode === "INVALID_CITATION"
                ? "The response could not be verified against its source references."
                : errorCode === "KNOWLEDGE_NOT_PUBLIC"
                  ? "This knowledge is unavailable in public chat."
                  : errorCode.startsWith("TOOL_") ||
                      errorCode.startsWith("MCP_")
                    ? "A configured tool is unavailable or its policy rejected the request. Check the workspace tool traces."
                    : c.fallbackResponse,
          status,
        });
      else
        write("done", {
          runId,
          status,
          inputTokens,
          outputTokens,
          citations,
          retrievalMs,
        });
    } catch {
      write("error", {
        code: "PERSISTENCE_ERROR",
        message: "The response could not be saved.",
      });
    } finally {
      span.setAttribute("run.status", status);
      if (inputTokens !== null)
        span.setAttribute("model.input_tokens", inputTokens);
      if (outputTokens !== null)
        span.setAttribute("model.output_tokens", outputTokens);
      span.end();
      reply.raw.end();
    }
  }
}
export async function recoverInterruptedRuns() {
  await sql`UPDATE tool_executions SET status='failed',error_code='PROCESS_INTERRUPTED',finished_at=now() WHERE status='running' AND started_at<now()-interval '5 minutes'`;
  await sql`UPDATE agent_runs SET status='failed',error_code='PROCESS_INTERRUPTED',finished_at=now() WHERE status='running' AND started_at<now()-interval '5 minutes'`;
}
export async function registerAgentRoutes(
  app: FastifyInstance,
  override?: ProviderFactory,
  embeddingOverride?: EmbeddingFactory,
) {
  const ragTool = new PostgresRagTool(embeddingOverride);
  // Requests time out after 90 seconds. Recover records left running by a
  // process crash without cancelling another instance's active requests.
  await recoverInterruptedRuns();
  const recovery = setInterval(() => {
    void recoverInterruptedRuns().catch(() =>
      app.log.error("Agent run recovery failed"),
    );
  }, 60000);
  recovery.unref();
  app.addHook("onClose", async () => {
    clearInterval(recovery);
  });
  const factory =
    override ??
    ((c: ModelConnection) =>
      createProvider(c, safeTransport(allowedHosts(), privateHosts())));
  function schema(body: z.ZodType) {
    return {
      schema: {
        body: z.toJSONSchema(body, { io: "input", target: "draft-7" }),
      },
    };
  }
  app.get("/workspaces/:workspaceId/models", async (r) => {
    const u = await actor(r);
    const w = await workspaceAccess(u.id, id(params(r).workspaceId));
    return sql`SELECT id,name,provider,model_id,base_url,secret_id,context_window,max_output_tokens,capabilities FROM model_configurations WHERE workspace_id=${w.id} AND organization_id=${w.organization_id} ORDER BY name`;
  });
  app.post(
    "/workspaces/:workspaceId/models",
    schema(modelInput),
    async (r, reply) => {
      const u = await actor(r);
      const w = await workspaceAccess(
        u.id,
        id(params(r).workspaceId),
        "model:manage",
      );
      const data = modelInput.parse(r.body);
      const baseUrl = data.baseUrl ?? defaultBaseUrls[data.provider];
      try {
        validateEndpoint(baseUrl, allowedHosts(), privateHosts());
      } catch (error) {
        if (
          error instanceof ProviderError &&
          error.code === "ENDPOINT_NOT_ALLOWED"
        )
          throw new HttpError(
            400,
            `Model endpoint ${new URL(baseUrl).host} is not approved. Add this host to MODEL_ALLOWED_HOSTS in the API and worker environment, preserving existing hosts, then restart both services.`,
          );
        if (error instanceof ProviderError && error.code === "HTTPS_REQUIRED")
          throw new HttpError(
            400,
            "Model endpoint requires HTTPS. Use the provider's HTTPS base URL.",
          );
        throw new HttpError(
          400,
          "Model endpoint must be an approved HTTPS URL without embedded credentials, query parameters or fragments.",
        );
      }
      if (data.provider !== "openai-compatible" && !data.secretId)
        throw new HttpError(400, "This provider requires a workspace secret");
      if (
        data.provider !== "openai-compatible" &&
        baseUrl !== defaultBaseUrls[data.provider]
      )
        throw new HttpError(
          400,
          "Use the OpenAI-compatible adapter for custom endpoints",
        );
      if (data.secretId) {
        const [secret] =
          await sql`SELECT id FROM secrets WHERE id=${data.secretId} AND workspace_id=${w.id} AND organization_id=${w.organization_id}`;
        if (!secret)
          throw new HttpError(400, "Choose a secret from this workspace");
      }
      const modelId = randomUUID();
      await sql.begin(async (tx) => {
        await tx`INSERT INTO model_configurations(id,organization_id,workspace_id,name,provider,model_id,base_url,secret_id,context_window,max_output_tokens,capabilities) VALUES (${modelId},${w.organization_id},${w.id},${data.name},${data.provider},${data.modelId},${baseUrl},${data.secretId},${data.contextWindow},${data.maxOutputTokens},${tx.json(data.capabilities)})`;
        await audit(
          tx,
          r,
          u.id,
          "model.created",
          modelId,
          w.organization_id,
          w.id,
        );
      });
      return reply.code(201).send({ id: modelId });
    },
  );
  app.post("/models/:modelId/test", async (r) => {
    const u = await actor(r);
    const [m] =
      await sql`SELECT workspace_id FROM model_configurations WHERE id=${id(params(r).modelId)}`;
    if (!m) throw new HttpError(404, "Model not found");
    const w = await workspaceAccess(u.id, m.workspace_id, "model:manage");
    const model = await modelSnapshot(id(params(r).modelId), w.id);
    const p = factory(await connection(model, w.id, w.organization_id));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
      let text = "";
      for await (const e of p.stream({
        system: "Reply briefly.",
        messages: [{ role: "user", content: "Reply with the word Connected." }],
        temperature: 0,
        topP: null,
        maxOutputTokens: Math.min(32, model.maxOutputTokens),
        signal: controller.signal,
      }))
        if (e.type === "token") text += e.text;
      return { ok: true, response: text.slice(0, 500) };
    } catch (e) {
      throw new HttpError(
        502,
        e instanceof ProviderError
          ? `Provider test failed: ${e.code}`
          : "Provider test failed",
      );
    } finally {
      clearTimeout(timeout);
    }
  });
  app.get("/workspaces/:workspaceId/agents", async (r) => {
    const u = await actor(r);
    const w = await workspaceAccess(u.id, id(params(r).workspaceId));
    return sql`SELECT id,name,description,revision,updated_at FROM agents WHERE workspace_id=${w.id} AND organization_id=${w.organization_id} AND archived_at IS NULL ORDER BY updated_at DESC,id`;
  });
  app.post(
    "/workspaces/:workspaceId/agents",
    schema(agentInput),
    async (r, reply) => {
      const u = await actor(r);
      const w = await workspaceAccess(
        u.id,
        id(params(r).workspaceId),
        "agent:create",
      );
      const data = agentInput.parse(r.body);
      await validateKnowledgeIds(
        data.config.rag.knowledgeBaseIds,
        w.id,
        w.organization_id,
      );
      await validateToolIds(data.config.tools.toolIds, {
        workspaceId: w.id,
        organizationId: w.organization_id,
      });
      validateAgentModel(
        data.config,
        await modelSnapshot(data.config.modelId, w.id),
      );
      const agentId = randomUUID();
      await sql.begin(async (tx) => {
        await tx`INSERT INTO agents(id,organization_id,workspace_id,name,description,public_description,draft_config,created_by) VALUES (${agentId},${w.organization_id},${w.id},${data.name},${data.description},${data.publicDescription},${tx.json(data.config)},${u.id})`;
        await audit(
          tx,
          r,
          u.id,
          "agent.created",
          agentId,
          w.organization_id,
          w.id,
        );
      });
      return reply.code(201).send({ id: agentId, revision: 1 });
    },
  );
  app.get("/agents/:agentId", async (r) => {
    const { a } = await ownedAgent(r);
    return a;
  });
  app.put("/agents/:agentId", schema(agentUpdate), async (r) => {
    const { u, a, w } = await ownedAgent(r, "agent:update");
    const data = agentUpdate.parse(r.body);
    await validateKnowledgeIds(
      data.config.rag.knowledgeBaseIds,
      w.id,
      w.organization_id,
    );
    await validateToolIds(data.config.tools.toolIds, {
      workspaceId: w.id,
      organizationId: w.organization_id,
    });
    validateAgentModel(
      data.config,
      await modelSnapshot(data.config.modelId, w.id),
    );
    return sql.begin(async (tx) => {
      const [saved] =
        await tx`UPDATE agents SET name=${data.name},description=${data.description},public_description=${data.publicDescription},draft_config=${tx.json(data.config)},revision=revision+1,updated_at=now() WHERE id=${a.id} AND revision=${data.revision} RETURNING revision`;
      if (!saved)
        throw new HttpError(409, "Draft changed; reload before saving");
      await audit(tx, r, u.id, "agent.updated", a.id, w.organization_id, w.id);
      return { id: a.id, revision: saved.revision };
    });
  });
  app.delete("/agents/:agentId", async (r) => {
    const { u, a, w } = await ownedAgent(r, "agent:delete");
    await sql.begin(async (tx) => {
      await tx`UPDATE agents SET archived_at=now() WHERE id=${a.id}`;
      await tx`UPDATE deployments SET enabled=false WHERE agent_id=${a.id}`;
      await audit(tx, r, u.id, "agent.archived", a.id, w.organization_id, w.id);
    });
    return { ok: true };
  });
  app.post(
    "/agents/:agentId/publish",
    schema(publishInput),
    async (r, reply) => {
      const { u, a, w } = await ownedAgent(r, "agent:publish");
      const data = publishInput.parse(r.body);
      const versionId = randomUUID();
      const result = await sql.begin(async (tx) => {
        const [locked] = await tx<
          AgentRow[]
        >`SELECT * FROM agents WHERE id=${a.id} FOR UPDATE`;
        if (!locked || locked.revision !== data.revision)
          throw new HttpError(409, "Draft changed; reload before publishing");
        const c = agentConfig.parse(locked.draft_config);
        await validateKnowledgeIds(
          c.rag.knowledgeBaseIds,
          w.id,
          w.organization_id,
        );
        await validateToolIds(c.tools.toolIds, {
          workspaceId: w.id,
          organizationId: w.organization_id,
        });
        const model = await modelSnapshot(c.modelId, w.id);
        validateAgentModel(c, model);
        await connection(model, w.id, w.organization_id);
        const [previous] =
          await tx`SELECT COALESCE(max(version),0) AS latest FROM agent_versions WHERE agent_id=${a.id}`;
        const version = Number(previous!.latest) + 1;
        await tx`INSERT INTO agent_versions(id,agent_id,workspace_id,organization_id,version,name,public_description,config,model_snapshot,model_id,published_by) VALUES (${versionId},${a.id},${w.id},${w.organization_id},${version},${locked.name},${locked.public_description},${tx.json(c)},${tx.json(model)},${model.id},${u.id})`;
        await audit(
          tx,
          r,
          u.id,
          "agent.published",
          versionId,
          w.organization_id,
          w.id,
        );
        return { id: versionId, version };
      });
      return reply.code(201).send(result);
    },
  );
  app.get("/agents/:agentId/versions", async (r) => {
    const { a } = await ownedAgent(r);
    return sql`SELECT id,version,name,public_description,config,published_at FROM agent_versions WHERE agent_id=${a.id} ORDER BY version DESC`;
  });
  app.post(
    "/agents/:agentId/rollback/:versionId",
    schema(publishInput),
    async (r) => {
      const { u, a, w } = await ownedAgent(r, "agent:update");
      const data = publishInput.parse(r.body);
      const [v] =
        await sql`SELECT config,name,public_description FROM agent_versions WHERE id=${id(params(r).versionId)} AND agent_id=${a.id}`;
      if (!v) throw new HttpError(404, "Version not found");
      return sql.begin(async (tx) => {
        const [saved] =
          await tx`UPDATE agents SET draft_config=${tx.json(v.config)},name=${v.name},public_description=${v.public_description},revision=revision+1,updated_at=now() WHERE id=${a.id} AND revision=${data.revision} RETURNING revision`;
        if (!saved) throw new HttpError(409, "Draft changed");
        await audit(
          tx,
          r,
          u.id,
          "agent.rolled_back",
          a.id,
          w.organization_id,
          w.id,
        );
        return { revision: saved.revision };
      });
    },
  );
  app.post(
    "/agents/:agentId/deployments",
    schema(deploymentInput),
    async (r, reply) => {
      const { u, a, w } = await ownedAgent(r, "agent:publish");
      const data = deploymentInput.parse(r.body);
      const [v] =
        await sql`SELECT id,config FROM agent_versions WHERE id=${data.versionId} AND agent_id=${a.id}`;
      if (!v)
        throw new HttpError(400, "Select a published version of this agent");
      await validateKnowledgeIds(
        agentConfig.parse(v.config).rag.knowledgeBaseIds,
        w.id,
        w.organization_id,
        true,
      );
      await validateToolIds(agentConfig.parse(v.config).tools.toolIds, {
        workspaceId: w.id,
        organizationId: w.organization_id,
        publicAccess: true,
      });
      const deploymentId = randomUUID();
      await sql.begin(async (tx) => {
        await tx`INSERT INTO deployments(id,organization_id,workspace_id,agent_id,version_id,name) VALUES (${deploymentId},${w.organization_id},${w.id},${a.id},${v.id},${data.name})`;
        await audit(
          tx,
          r,
          u.id,
          "deployment.created",
          deploymentId,
          w.organization_id,
          w.id,
        );
      });
      return reply
        .code(201)
        .send({ id: deploymentId, path: `/chat/${deploymentId}` });
    },
  );
  app.get("/agents/:agentId/deployments", async (r) => {
    const { a } = await ownedAgent(r);
    return sql`SELECT d.id,d.name,d.enabled,v.version,d.version_id FROM deployments d JOIN agent_versions v ON v.id=d.version_id WHERE d.agent_id=${a.id} ORDER BY d.created_at DESC`;
  });
  app.delete("/agents/:agentId/deployments/:deploymentId", async (r) => {
    const { u, a, w } = await ownedAgent(r, "agent:publish");
    await sql.begin(async (tx) => {
      const [d] =
        await tx`UPDATE deployments SET enabled=false WHERE id=${id(params(r).deploymentId)} AND agent_id=${a.id} RETURNING id`;
      if (!d) throw new HttpError(404, "Deployment not found");
      await audit(
        tx,
        r,
        u.id,
        "deployment.disabled",
        d.id,
        w.organization_id,
        w.id,
      );
    });
    return { ok: true };
  });
  app.get("/workspaces/:workspaceId/conversations", async (r) => {
    const u = await actor(r);
    const w = await workspaceAccess(
      u.id,
      id(params(r).workspaceId),
      "conversation:view",
    );
    const q = z
      .object({
        before: z.iso.datetime().optional(),
        beforeId: z.uuid().optional(),
      })
      .parse(r.query);
    if (!!q.before !== !!q.beforeId)
      throw new HttpError(400, "Cursor requires before and beforeId");
    return sql`SELECT c.id,c.agent_id,c.deployment_id,c.created_at,a.name FROM conversations c JOIN agents a ON a.id=c.agent_id WHERE c.workspace_id=${w.id} AND (c.created_at,c.id)<(${q.before ?? new Date().toISOString()},${q.beforeId ?? "ffffffff-ffff-ffff-ffff-ffffffffffff"}) ORDER BY c.created_at DESC,c.id DESC LIMIT 30`;
  });
  app.get("/conversations/:conversationId/messages", async (r) => {
    const u = await actor(r);
    const [c] = await sql<
      ConversationRow[]
    >`SELECT * FROM conversations WHERE id=${id(params(r).conversationId)}`;
    if (!c) throw new HttpError(404, "Conversation not found");
    await workspaceAccess(u.id, c.workspace_id, "conversation:view");
    return sql`SELECT m.id,m.role,m.content,m.citations,m.created_at,ar.status,m.run_id FROM messages m JOIN agent_runs ar ON ar.id=m.run_id WHERE m.conversation_id=${c.id} ORDER BY m.created_at,m.id`;
  });
  app.post(
    "/agents/:agentId/chat",
    {
      ...schema(chatInput),
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (r, reply) => {
      const { u, a, w } = await ownedAgent(r, "agent:execute");
      const data = chatInput.parse(r.body);
      let conversation: ConversationRow | undefined;
      if (data.conversationId) {
        [conversation] = await sql<
          ConversationRow[]
        >`SELECT * FROM conversations WHERE id=${data.conversationId} AND agent_id=${a.id} AND user_id=${u.id} AND deployment_id IS NULL`;
        if (!conversation) throw new HttpError(404, "Conversation not found");
      } else {
        const c = agentConfig.parse(a.draft_config);
        const model = await modelSnapshot(c.modelId, w.id);
        await connection(model, w.id, w.organization_id);
        const conversationId = randomUUID();
        [conversation] = await sql<
          ConversationRow[]
        >`INSERT INTO conversations(id,organization_id,workspace_id,agent_id,user_id,config_snapshot,model_snapshot) VALUES (${conversationId},${w.organization_id},${w.id},${a.id},${u.id},${sql.json(c)},${sql.json(model)}) RETURNING *`;
      }
      await streamChat(
        r,
        reply,
        conversation!,
        data.message,
        factory,
        undefined,
        ragTool,
      );
    },
  );
  app.get("/public/deployments/:deploymentId", async (r) => {
    const d = await publicDeployment(id(params(r).deploymentId));
    const c = agentConfig.parse(d.config);
    return {
      id: d.id,
      name: d.name,
      description: d.public_description,
      welcomeMessage: c.welcomeMessage,
      conversationStarters: c.conversationStarters,
    };
  });
  app.post(
    "/public/deployments/:deploymentId/chat",
    {
      ...schema(chatInput),
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
    },
    async (r, reply) => {
      const d = await publicDeployment(id(params(r).deploymentId));
      const data = chatInput.parse(r.body);
      let conversation: ConversationRow | undefined;
      let raw: string | undefined;
      if (data.conversationId) {
        [conversation] = await sql<
          ConversationRow[]
        >`SELECT * FROM conversations WHERE id=${data.conversationId} AND deployment_id=${d.id} AND user_id IS NULL`;
        const bearer = r.headers.authorization?.replace(/^Bearer /, "") ?? "";
        if (
          !conversation?.guest_token_hash ||
          !equalToken(bearer, conversation.guest_token_hash)
        )
          throw new HttpError(404, "Conversation not found");
      } else {
        await connection(
          modelSnapshotSchema.parse(d.model_snapshot),
          d.workspace_id,
          d.organization_id,
        );
        raw = token();
        [conversation] = await sql<
          ConversationRow[]
        >`INSERT INTO conversations(id,organization_id,workspace_id,agent_id,version_id,deployment_id,guest_token_hash,config_snapshot,model_snapshot) VALUES (${randomUUID()},${d.organization_id},${d.workspace_id},${d.agent_id},${d.version_id},${d.id},${digest(raw)},${sql.json(d.config)},${sql.json(d.model_snapshot)}) RETURNING *`;
      }
      await streamChat(
        r,
        reply,
        conversation!,
        data.message,
        factory,
        raw,
        ragTool,
      );
    },
  );
}
