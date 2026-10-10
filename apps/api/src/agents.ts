import { assertQualityGate } from "./quality-gate.js";
import { requireWidgetOrigin } from "./channels.js";
import {
  responseEnvelope,
  generativePrompt,
  type RenderedBlock,
} from "@agentconnect/schemas/generative";
import { prepareArtifacts, type Artifact } from "./generative.js";
import { deleteKnowledge } from "./knowledge-storage.js";
import { queueRunWebhooks } from "./webhooks.js";
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
  modelUpdate,
  type ModelInput,
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
async function validateModelRegistration(
  data: ModelInput,
  workspaceId: string,
  organizationId: string,
) {
  const baseUrl = data.baseUrl ?? defaultBaseUrls[data.provider];
  try {
    validateEndpoint(baseUrl, allowedHosts(), privateHosts());
  } catch (error) {
    if (error instanceof ProviderError && error.code === "ENDPOINT_NOT_ALLOWED")
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
      await sql`SELECT id FROM secrets WHERE id=${data.secretId} AND workspace_id=${workspaceId} AND organization_id=${organizationId}`;
    if (!secret)
      throw new HttpError(400, "Choose a secret from this workspace");
  }

  if (data.maxOutputTokens >= data.contextWindow)
    throw new HttpError(
      400,
      "Output limit must fit in the model context window",
    );
  return baseUrl;
}
export async function modelSnapshot(modelId: string, workspaceId: string) {
  const [m] =
    await sql`SELECT id,provider,model_id,base_url,secret_id,capabilities,context_window,max_output_tokens FROM model_configurations WHERE id=${modelId} AND workspace_id=${workspaceId} AND archived_at IS NULL`;
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
      const [locked] =
        await tx`SELECT conversation_mode FROM conversations WHERE id=${conversation.id} FOR UPDATE`;
      if (!locked)
        throw new HttpError(404, "Conversation expired or unavailable");
      if (locked.conversation_mode !== "ai")
        throw new HttpError(
          409,
          "This conversation is with the human support team",
        );
      await tx`INSERT INTO agent_runs(id,conversation_id,organization_id,workspace_id,status,trace_id) VALUES (${runId},${conversation.id},${conversation.organization_id},${conversation.workspace_id},'running',${traceId})`;
      await tx`UPDATE conversations SET last_customer_message_at=now() WHERE id=${conversation.id}`;
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
  let uiBlocks: RenderedBlock[] = [];
  let artifacts: Artifact[] = [];
  const messageId = randomUUID();
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
      (sources.length ? groundedPrompt(sources) : "") +
      toolsResult.grounding +
      (c.generative.enabled
        ? generativePrompt() +
          ` Allowed block types: ${c.generative.allowedBlocks.join(",")}.`
        : "");
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
        if (!c.generative.enabled) write("token", { text: event.text });
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
    if (c.generative.enabled) {
      try {
        const envelope = responseEnvelope.parse(JSON.parse(output));
        if (
          envelope.blocks.some(
            (b) => !c.generative.allowedBlocks.includes(b.type),
          )
        )
          throw new Error("Unsupported component");
        const prepared = await prepareArtifacts(
          envelope,
          conversation.workspace_id,
          conversation.organization_id,
        );
        uiBlocks = prepared.blocks;
        artifacts = prepared.artifacts;
        if (controller.signal.aborted) throw new ProviderError("CANCELLED");
        output = [
          envelope.message,
          ...envelope.blocks
            .filter((b) => b.type === "text")
            .map((b) => (b.type === "text" ? b.content : "")),
        ]
          .filter(Boolean)
          .join("\n\n");
      } catch (error) {
        output = "";
        if (error instanceof ProviderError) throw error;
        throw new ProviderError("INVALID_UI_RESPONSE");
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
    if (c.generative.enabled) {
      output = "";
      uiBlocks = [];
      await Promise.allSettled(artifacts.map((a) => deleteKnowledge(a.key)));
      artifacts = [];
    }
    span.setStatus({ code: SpanStatusCode.ERROR, message: errorCode });
    r.log.warn(
      {
        runId,
        traceId,
        code: errorCode,
        provider: model.provider,
        modelId: model.modelId,
        hostname: new URL(model.baseUrl).hostname,
        httpStatus: e instanceof ProviderError ? e.httpStatus : undefined,
        providerCode:
          e instanceof ProviderError ? e.details?.providerCode : undefined,
        parameter:
          e instanceof ProviderError ? e.details?.parameter : undefined,
        retryable: e instanceof ProviderError ? e.retryable : false,
        temperature: c.temperature,
        topP: c.topP,
        maxOutputTokens: c.maxOutputTokens,
        credentialSelected: !!model.secretId,
        hint:
          errorCode === "PROVIDER_HTTP_ERROR"
            ? "Check model identifier, account access, output token limit and supported sampling parameters."
            : errorCode === "AUTHENTICATION_FAILED"
              ? "Check the selected workspace credential."
              : errorCode === "RATE_LIMITED"
                ? "Check provider quota and retry later."
                : "Use the failure code and trace ID to investigate the run.",
      },
      "Agent chat failed",
    );
  } finally {
    clearTimeout(timer);
    clearInterval(heartbeat);
    reply.raw.off("close", disconnected);
    try {
      await sql.begin(async (tx) => {
        if (output || uiBlocks.length)
          await tx`UPDATE conversations SET last_agent_message_at=now() WHERE id=${conversation.id}`;
        if (output || uiBlocks.length)
          await tx`INSERT INTO messages(id,conversation_id,organization_id,workspace_id,run_id,role,content,citations,ui_blocks) VALUES (${messageId},${conversation.id},${conversation.organization_id},${conversation.workspace_id},${runId},'assistant',${output},${tx.json(citations.map((s) => ({ ...s })))},${tx.json(uiBlocks as never)})`;
        for (const a of artifacts)
          await tx`INSERT INTO generated_artifacts(id,organization_id,workspace_id,message_id,name,content_type,storage_key,byte_size) VALUES (${a.id},${conversation.organization_id},${conversation.workspace_id},${messageId},${a.name},${a.contentType},${a.key},${a.byteSize})`;
        await tx`UPDATE agent_runs SET status=${status},input_tokens=${inputTokens},output_tokens=${outputTokens},error_code=${errorCode},finished_at=now(),retrieval=${tx.json(sources.map((s) => ({ ...s })))},retrieval_ms=${retrievalMs} WHERE id=${runId}`;
        await tx`UPDATE agent_runs ar SET input_usd_per_million=p.input_usd_per_million,output_usd_per_million=p.output_usd_per_million FROM model_prices p WHERE ar.id=${runId} AND p.model_id=${model.id} AND p.workspace_id=${conversation.workspace_id}`;
        await queueRunWebhooks(tx, {
          id: runId,
          workspaceId: conversation.workspace_id,
          organizationId: conversation.organization_id,
          status,
          traceId,
        });
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
      else {
        if (c.generative.enabled)
          write("ui", {
            messageId,
            message: output,
            blocks: uiBlocks,
            actionsEnabled:
              !conversation.deployment_id || c.generative.allowPublicForms,
          });
        write("done", {
          runId,
          status,
          inputTokens,
          outputTokens,
          citations,
          retrievalMs,
        });
      }
    } catch {
      await Promise.allSettled(artifacts.map((a) => deleteKnowledge(a.key)));
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
    return sql`SELECT id,name,provider,model_id,base_url,secret_id,context_window,max_output_tokens,capabilities,revision FROM model_configurations WHERE workspace_id=${w.id} AND organization_id=${w.organization_id} AND archived_at IS NULL ORDER BY name`;
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
      const baseUrl = await validateModelRegistration(
        data,
        w.id,
        w.organization_id,
      );
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
  async function ownedModel(r: FastifyRequest) {
    const u = await actor(r);
    const [m] =
      await sql`SELECT * FROM model_configurations WHERE id=${id(params(r).modelId)} AND archived_at IS NULL`;
    if (!m) throw new HttpError(404, "Model not found");
    const w = await workspaceAccess(u.id, m.workspace_id, "model:manage");
    return { u, m, w };
  }
  app.put("/models/:modelId", schema(modelUpdate), async (r) => {
    const { u, m, w } = await ownedModel(r);
    const data = modelUpdate.parse(r.body);
    const baseUrl = await validateModelRegistration(
      data,
      w.id,
      w.organization_id,
    );
    return sql.begin(async (tx) => {
      const [locked] =
        await tx`SELECT revision FROM model_configurations WHERE id=${m.id} AND archived_at IS NULL FOR UPDATE`;
      if (!locked || locked.revision !== data.revision)
        throw new HttpError(409, "Model changed; reload before saving");
      const drafts =
        await tx`SELECT draft_config FROM agents WHERE workspace_id=${w.id} AND organization_id=${w.organization_id} AND archived_at IS NULL AND draft_config->>'modelId'=${m.id}`;
      for (const a of drafts)
        validateAgentModel(agentConfig.parse(a.draft_config), {
          id: m.id,
          ...data,
          baseUrl,
        });
      const [saved] =
        await tx`UPDATE model_configurations SET name=${data.name},provider=${data.provider},model_id=${data.modelId},base_url=${baseUrl},secret_id=${data.secretId},context_window=${data.contextWindow},max_output_tokens=${data.maxOutputTokens},capabilities=${tx.json(data.capabilities)},revision=revision+1 WHERE id=${m.id} RETURNING revision`;
      await audit(tx, r, u.id, "model.updated", m.id, w.organization_id, w.id);
      return { id: m.id, revision: saved!.revision };
    });
  });
  app.delete("/models/:modelId", schema(publishInput), async (r) => {
    const { u, m, w } = await ownedModel(r),
      data = publishInput.parse(r.body);
    return sql.begin(async (tx) => {
      const [locked] =
        await tx`SELECT revision FROM model_configurations WHERE id=${m.id} AND archived_at IS NULL FOR UPDATE`;
      if (!locked || locked.revision !== data.revision)
        throw new HttpError(409, "Model changed; reload before deleting");
      const [used] =
        await tx`SELECT id FROM agents WHERE workspace_id=${w.id} AND organization_id=${w.organization_id} AND archived_at IS NULL AND draft_config->>'modelId'=${m.id} LIMIT 1`;
      if (used)
        throw new HttpError(
          409,
          "An active agent draft uses this model. Select another model in that agent or archive the agent before deleting it.",
        );
      await tx`UPDATE model_configurations SET archived_at=now(),revision=revision+1 WHERE id=${m.id}`;
      await audit(tx, r, u.id, "model.deleted", m.id, w.organization_id, w.id);
      return { ok: true };
    });
  });
  app.post("/models/:modelId/test", async (r) => {
    const u = await actor(r);
    const [m] =
      await sql`SELECT workspace_id FROM model_configurations WHERE id=${id(params(r).modelId)} AND archived_at IS NULL`;
    if (!m) throw new HttpError(404, "Model not found");
    const w = await workspaceAccess(u.id, m.workspace_id, "model:manage");
    const model = await modelSnapshot(id(params(r).modelId), w.id);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
      const p = factory(await connection(model, w.id, w.organization_id));
      let text = "";
      for await (const e of p.stream({
        system: "Reply briefly.",
        messages: [{ role: "user", content: "Reply with the word Connected." }],
        temperature: 0,
        topP: null,
        maxOutputTokens: Math.min(1024, model.maxOutputTokens),
        signal: controller.signal,
      }))
        if (e.type === "token") text += e.text;
      if (!text.trim()) throw new ProviderError("EMPTY_PROVIDER_RESPONSE");
      return { ok: true, response: text.slice(0, 500) };
    } catch (e) {
      if (e instanceof HttpError) throw e;
      if (controller.signal.aborted)
        throw new HttpError(
          504,
          "Provider test timed out. Check provider availability and network access.",
        );
      const code =
        e instanceof ProviderError ? e.code : "NETWORK_OR_PROVIDER_ERROR";
      const details = e instanceof ProviderError ? e.details : undefined;
      const httpStatus = e instanceof ProviderError ? e.httpStatus : undefined;
      r.log.warn(
        {
          code,
          provider: model.provider,
          modelId: model.modelId,
          hostname: new URL(model.baseUrl).hostname,
          httpStatus,
          providerCode: details?.providerCode,
          parameter: details?.parameter,
          credentialSelected: !!model.secretId,
          temperatureSent: model.capabilities.temperature,
          maxOutputTokens: Math.min(1024, model.maxOutputTokens),
        },
        "Model connection test failed",
      );
      const hint =
        details?.providerCode === "model_not_found" ||
        details?.providerCode === "invalid_model"
          ? "The exact model identifier is unavailable to the selected provider account/project. Verify model access."
          : details?.parameter === "temperature" ||
              details?.parameter === "top_p"
            ? "The provider rejected a sampling parameter. Disable the corresponding capability if this model does not support it."
            : code === "EMPTY_PROVIDER_RESPONSE"
              ? "The provider returned no visible text. Check the model's reasoning/output budget and API compatibility."
              : code === "AUTHENTICATION_FAILED"
                ? "Check the selected workspace credential and ensure the provider matches its API key."
                : code === "RATE_LIMITED"
                  ? "The provider rate limit or quota was reached. Retry later and check account limits."
                  : code === "PROVIDER_HTTP_ERROR"
                    ? "Check the base URL, exact model identifier, account access and supported parameters."
                    : code === "ENDPOINT_NOT_ALLOWED"
                      ? "Approve the provider host in MODEL_ALLOWED_HOSTS and restart the API and worker."
                      : "Check provider configuration and network access.";
      const context = [
        httpStatus ? `HTTP ${httpStatus}` : "",
        details?.providerCode,
        details?.parameter ? `parameter ${details.parameter}` : "",
      ]
        .filter(Boolean)
        .join("; ");
      throw new HttpError(
        502,
        `Provider test failed: ${code}${context ? ` (${context})` : ""}. ${hint}`,
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
        await assertQualityGate(tx, locked, c, model);
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
        await tx`INSERT INTO deployments(id,organization_id,workspace_id,agent_id,version_id,name,environment) VALUES (${deploymentId},${w.organization_id},${w.id},${a.id},${v.id},${data.name},${data.environment})`;
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
    return sql`SELECT d.id,d.name,d.enabled,d.environment,v.version,d.version_id FROM deployments d JOIN agent_versions v ON v.id=d.version_id WHERE d.agent_id=${a.id} ORDER BY d.created_at DESC`;
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
    return sql`SELECT m.id,m.role,m.content,m.citations,m.ui_blocks,m.created_at,ar.status,m.run_id FROM messages m JOIN agent_runs ar ON ar.id=m.run_id WHERE m.conversation_id=${c.id} ORDER BY m.created_at,m.id`;
  });
  app.post(
    "/agents/:agentId/chat",
    {
      ...schema(chatInput),
      config: {
        rateLimit: {
          max: 30,
          timeWindow: "1 minute",
          keyGenerator: (r: FastifyRequest) =>
            /^Bearer ac_/.test(r.headers.authorization ?? "")
              ? digest(r.headers.authorization!)
              : r.ip,
        },
      },
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
        >`INSERT INTO conversations(id,organization_id,workspace_id,agent_id,user_id,config_snapshot,model_snapshot,channel) VALUES (${conversationId},${w.organization_id},${w.id},${a.id},${u.id},${sql.json(c)},${sql.json(model)},'playground') RETURNING *`;
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
  for (const channel of ["deployments", "widgets"])
    app.get(`/public/${channel}/:deploymentId`, async (r) => {
      const d = await publicDeployment(id(params(r).deploymentId));
      const c = agentConfig.parse(d.config);
      return {
        id: d.id,
        name: d.name,
        description: d.public_description,
        welcomeMessage: c.welcomeMessage,
        conversationStarters: c.conversationStarters,
        ...(channel === "widgets"
          ? {
              widget: (
                await sql`SELECT widget_settings FROM deployments WHERE id=${d.id}`
              )[0]!.widget_settings,
            }
          : {}),
      };
    });
  for (const channel of ["deployments", "widgets"])
    app.post(
      `/public/${channel}/:deploymentId/chat`,
      {
        ...schema(chatInput),
        config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
      },
      async (r, reply) => {
        if (channel === "widgets") await requireWidgetOrigin(r);
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
          const [binding] =
            await sql`SELECT channel,widget_origin FROM conversations WHERE id=${conversation!.id}`;
          if (
            (channel === "widgets") !== (binding!.channel === "widget") ||
            (channel === "widgets" &&
              binding!.widget_origin !== r.headers.origin)
          )
            throw new HttpError(
              403,
              "Conversation channel or origin does not match",
            );
        } else {
          await connection(
            modelSnapshotSchema.parse(d.model_snapshot),
            d.workspace_id,
            d.organization_id,
          );
          raw = token();
          [conversation] = await sql<
            ConversationRow[]
          >`INSERT INTO conversations(id,organization_id,workspace_id,agent_id,version_id,deployment_id,guest_token_hash,config_snapshot,model_snapshot,channel,widget_origin) VALUES (${randomUUID()},${d.organization_id},${d.workspace_id},${d.agent_id},${d.version_id},${d.id},${digest(raw)},${sql.json(d.config)},${sql.json(d.model_snapshot)},${channel === "widgets" ? "widget" : "hosted"},${channel === "widgets" ? r.headers.origin! : null}) RETURNING *`;
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
