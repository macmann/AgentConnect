import { agentConfig } from "@agentconnect/schemas/agents";
import {
  createProvider,
  safeTransport,
  ProviderError,
  type ProviderFactory,
} from "@agentconnect/provider-sdk";
import type { EmbeddingFactory } from "@agentconnect/provider-sdk/embeddings";
import { SingleAgentRuntime } from "@agentconnect/agent-sdk";
import { groundedPrompt, citedSources } from "@agentconnect/rag/tool";
import { KnowledgeError } from "@agentconnect/rag/parsers";
import {
  modelSnapshotSchema,
  connection,
  validateAgentModel,
} from "./agent-models.js";
import {
  PostgresRagTool,
  validateKnowledgeIds,
  hosts,
} from "./knowledge-core.js";
import {
  validateToolIds,
  runAgentTools,
  type ToolContext,
} from "./tool-runtime.js";
import { sql } from "./db.js";
import { config } from "./config.js";
export async function workflowAgentVersion(
  versionId: string,
  ctx: ToolContext,
) {
  const [v] =
    await sql`SELECT v.* FROM agent_versions v JOIN agents a ON a.id=v.agent_id WHERE v.id=${versionId} AND v.workspace_id=${ctx.workspaceId} AND v.organization_id=${ctx.organizationId} AND a.archived_at IS NULL`;
  if (!v) throw new ProviderError("WORKFLOW_AGENT_UNAVAILABLE");
  const c = agentConfig.parse(v.config),
    model = modelSnapshotSchema.parse(v.model_snapshot);
  validateAgentModel(c, model);
  await validateKnowledgeIds(
    c.rag.knowledgeBaseIds,
    ctx.workspaceId,
    ctx.organizationId,
  );
  await validateToolIds(c.tools.toolIds, ctx);
  const conn = await connection(model, ctx.workspaceId, ctx.organizationId);
  return { c, model, conn };
}
export async function executeWorkflowAgent(
  versionId: string,
  input: string,
  ctx: ToolContext,
  signal: AbortSignal,
  providerOverride?: ProviderFactory,
  embeddingOverride?: EmbeddingFactory,
) {
  const { c, model } = await workflowAgentVersion(versionId, ctx);
  return executeAgentSnapshot(
    c,
    model,
    input,
    ctx,
    signal,
    providerOverride,
    embeddingOverride,
  );
}
export async function executeAgentSnapshot(
  c: import("@agentconnect/schemas/agents").AgentConfig,
  model: import("./agent-models.js").ModelSnapshot,
  input: string,
  ctx: ToolContext,
  signal: AbortSignal,
  providerOverride?: ProviderFactory,
  embeddingOverride?: EmbeddingFactory,
) {
  validateAgentModel(c, model);
  await validateKnowledgeIds(
    c.rag.knowledgeBaseIds,
    ctx.workspaceId,
    ctx.organizationId,
  );
  await validateToolIds(c.tools.toolIds, ctx);
  const conn = await connection(model, ctx.workspaceId, ctx.organizationId);
  const provider = providerOverride
    ? providerOverride(conn)
    : createProvider(
        conn,
        safeTransport(
          hosts(config.MODEL_ALLOWED_HOSTS),
          hosts(config.MODEL_PRIVATE_HOSTS),
        ),
      );
  const sources = c.rag.knowledgeBaseIds.length
    ? await new PostgresRagTool(embeddingOverride).execute(
        input,
        c.rag.knowledgeBaseIds,
        c.rag,
        {
          workspaceId: ctx.workspaceId,
          organizationId: ctx.organizationId,
          publicAccess: false,
        },
        signal,
      )
    : [];
  if (c.rag.knowledgeBaseIds.length && !sources.length)
    throw new KnowledgeError("NO_RELEVANT_SOURCES");
  const tools = await runAgentTools(
    c,
    provider,
    input,
    ctx,
    signal,
    () => {},
    model.contextWindow - c.maxOutputTokens,
  );
  const grounding =
    (sources.length ? groundedPrompt(sources) : "") + tools.grounding;
  if (
    Buffer.byteLength(input) +
      Buffer.byteLength(JSON.stringify(c.prompt)) +
      Buffer.byteLength(grounding) >
    model.contextWindow - c.maxOutputTokens
  )
    throw new ProviderError("CONTEXT_LIMIT");
  let text = "",
    inputTokens: number | null = null,
    outputTokens: number | null = null;
  for await (const event of new SingleAgentRuntime().run(
    c,
    [{ role: "user", content: input }],
    provider,
    signal,
    grounding,
  )) {
    signal.throwIfAborted();
    if (event.type === "token") {
      text += event.text;
      if (Buffer.byteLength(text) > 64000)
        throw new ProviderError("OUTPUT_LIMIT");
    } else {
      inputTokens =
        event.inputTokens === null || tools.inputTokens === null
          ? null
          : event.inputTokens + tools.inputTokens;
      outputTokens =
        event.outputTokens === null || tools.outputTokens === null
          ? null
          : event.outputTokens + tools.outputTokens;
    }
  }
  const citations = citedSources(text, sources);
  if (sources.length && c.rag.requireCitations && !citations.length)
    throw new KnowledgeError("CITATION_REQUIRED");
  if (
    sources.length &&
    [...text.matchAll(/\[(\d+)\]/g)].some(
      (m) => !sources.some((s) => s.id === Number(m[1])),
    )
  )
    throw new KnowledgeError("INVALID_CITATION");
  return { output: text, inputTokens, outputTokens, citations, sources };
}
