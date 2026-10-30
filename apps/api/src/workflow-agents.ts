import { resolveAgentSkills, validateSkillSelection } from "./agent-skills.js";
import type {
  WorkflowNode,
  WorkflowGraph,
} from "@agentconnect/schemas/workflows";
import { modelSnapshot } from "./agents.js";
import { observe, observationContent } from "./ai-tracing.js";
import { routedProvider } from "./model-routing.js";
import { agentReranker } from "./agent-reranking.js";
import { enhancedRetrieval } from "./rag-enhancements.js";
import { knowledgeContextBudget, tokenCount } from "./context-control.js";
import { generateGroundedAnswer } from "./bank-runtime.js";
import { planKnowledgeUsage } from "./knowledge-usage.js";
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
  validateModelSet,
} from "./agent-models.js";
import {
  PostgresRagTool,
  validateKnowledgeSelection,
  hosts,
} from "./knowledge-core.js";
import {
  validateToolIds,
  availableAgentTools,
  runAgentTools,
  runGroundedFinancialTools,
  type ToolContext,
} from "./tool-runtime.js";
import { sql } from "./db.js";
import { config } from "./config.js";
export async function workflowAgentVersion(
  versionId: string,
  ctx: ToolContext,
  runtime = false,
) {
  const [v] =
    await sql`SELECT v.* FROM agent_versions v JOIN agents a ON a.id=v.agent_id WHERE v.id=${versionId} AND v.workspace_id=${ctx.workspaceId} AND v.organization_id=${ctx.organizationId} AND a.archived_at IS NULL`;
  if (!v) throw new ProviderError("WORKFLOW_AGENT_UNAVAILABLE");
  const c = agentConfig.parse(v.config),
    model = modelSnapshotSchema.parse(v.model_snapshot);
  validateModelSet(c, model);
  await validateKnowledgeSelection(
    c.rag,
    ctx.workspaceId,
    ctx.organizationId,
    !!ctx.publicAccess,
    !!ctx.publicAccess,
  );
  if (runtime) await availableAgentTools(c, ctx);
  else {
    await validateToolIds(c.tools.toolIds, ctx);
    await validateSkillSelection(c.skills, ctx);
  }
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
  const { c, model } = await workflowAgentVersion(versionId, ctx, true);
  return observe(
    "workflow.agent",
    "agent",
    { "agent.version": versionId },
    () =>
      executeAgentSnapshot(
        c,
        model,
        input,
        ctx,
        signal,
        providerOverride,
        embeddingOverride,
      ),
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
  candidateReleaseId?: string,
) {
  return observe(
    "agent.snapshot",
    "agent",
    {
      "workspace.id": ctx.workspaceId,
      "workflow.node.id": ctx.workflowNodeId ?? "",
      "agent.run.id": ctx.runId ?? "",
      "model.id": model.modelId,
    },
    async (span) => {
      observationContent(span, "input", input);
      validateModelSet(c, model);
      await validateKnowledgeSelection(
        c.rag,
        ctx.workspaceId,
        ctx.organizationId,
        !!ctx.publicAccess,
        !!ctx.publicAccess,
        candidateReleaseId,
      );
      await availableAgentTools(c, ctx);
      const factory: ProviderFactory =
        providerOverride ??
        ((conn) =>
          createProvider(
            conn,
            safeTransport(
              hosts(config.MODEL_ALLOWED_HOSTS),
              hosts(config.MODEL_PRIVATE_HOSTS),
            ),
          ));
      const metered = routedProvider(
        c,
        model,
        input,
        0,
        ctx.workspaceId,
        ctx.organizationId,
        factory,
      );
      const provider = metered.provider;
      const skills = await resolveAgentSkills(
        c,
        model,
        provider,
        [{ role: "user", content: input }],
        ctx,
        signal,
      );
      const completeUsage =
        c.modelRouting.enabled ||
        c.modelRouting.fallbackModelIds.length ||
        c.rag.queryRewrite ||
        config.QUERY_REWRITE_ENABLED ||
        c.rag.rerank ||
        (c.skills.usageMode === "automatic" && c.skills.versionIds.length > 0);
      const contextBudget = c.contextControls.enabled
        ? Infinity
        : model.contextWindow - c.maxOutputTokens;
      const knowledgePlan = await planKnowledgeUsage(
        c,
        provider,
        [{ role: "user", content: input }],
        signal,
        contextBudget,
        c.rag.usageMode === "automatic" && c.rag.knowledgeBaseIds.length
          ? await sql<
              { name: string; description: string }[]
            >`SELECT name,description FROM knowledge_bases WHERE id=ANY(${c.rag.knowledgeBaseIds}::uuid[]) AND workspace_id=${ctx.workspaceId} AND organization_id=${ctx.organizationId} AND archived_at IS NULL`
          : [],
      );
      let sources = knowledgePlan.retrieve
        ? (
            await enhancedRetrieval(
              new PostgresRagTool(embeddingOverride),
              provider,
              [{ role: "user", content: input }],
              input,
              c.rag.knowledgeBaseIds,
              c.rag,
              {
                workspaceId: ctx.workspaceId,
                organizationId: ctx.organizationId,
                publicAccess: !!ctx.publicAccess,
                candidateReleaseId,
                rewriteModel: model.modelId,
                countTokens: (text) =>
                  tokenCount(text, c.contextControls.tokenizer),
                maxContextTokens: knowledgeContextBudget(
                  c,
                  model,
                  [{ role: "user", content: input }],
                  skills.prompt,
                ),
              },
              signal,
              c.maxOutputTokens,
              agentReranker(
                c,
                model,
                ctx.workspaceId,
                ctx.organizationId,
                factory,
                metered,
              ),
            )
          ).sources
        : [];
      if (c.contextControls.enabled) {
        let used = 0;
        sources = sources.filter((source) => {
          const size = tokenCount(source.content, c.contextControls.tokenizer);
          if (used + size > c.contextControls.knowledgeBudget) return false;
          used += size;
          return true;
        });
      }
      if (c.answerPolicy.mode === "grounded") {
        const financial = await runGroundedFinancialTools(
          c,
          provider,
          [{ role: "user", content: input }],
          sources,
          ctx,
          signal,
          () => {},
          contextBudget,
        );
        const result = await generateGroundedAnswer(
          c,
          provider,
          [{ role: "user", content: input }],
          sources,
          signal,
          contextBudget,
          skills.prompt + financial.grounding,
        );
        return {
          output: result.message,
          inputTokens: completeUsage
            ? metered.usage().inputTokens
            : result.inputTokens === null || financial.inputTokens === null
              ? null
              : result.inputTokens + financial.inputTokens,
          outputTokens: completeUsage
            ? metered.usage().outputTokens
            : result.outputTokens === null || financial.outputTokens === null
              ? null
              : result.outputTokens + financial.outputTokens,
          citations: citedSources(result.message, sources),
          sources,
          modelUsage: metered.usage().modelUsage,
        };
      }
      if (knowledgePlan.retrieve && !sources.length)
        throw new KnowledgeError("NO_RELEVANT_SOURCES");
      const tools = await runAgentTools(
        c,
        provider,
        input,
        { ...ctx, knowledgeSources: sources },
        signal,
        () => {},
        contextBudget,
        skills.prompt,
      );
      tools.inputTokens =
        tools.inputTokens === null || knowledgePlan.inputTokens === null
          ? null
          : tools.inputTokens + knowledgePlan.inputTokens;
      tools.outputTokens =
        tools.outputTokens === null || knowledgePlan.outputTokens === null
          ? null
          : tools.outputTokens + knowledgePlan.outputTokens;
      const grounding =
        skills.prompt +
        (sources.length ? groundedPrompt(sources, c.rag) : "") +
        tools.grounding;
      if (
        !c.contextControls.enabled &&
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
      observationContent(span, "output", text);
      return {
        output: text,
        inputTokens: completeUsage ? metered.usage().inputTokens : inputTokens,
        outputTokens: completeUsage
          ? metered.usage().outputTokens
          : outputTokens,
        citations,
        sources,
        modelUsage: metered.usage().modelUsage,
      };
    },
  );
}

// Resolve workspace models on the server before persisting immutable run/release graphs.
export async function snapshotWorkflowAgents(
  graph: WorkflowGraph,
  workspaceId: string,
) {
  for (const node of graph.nodes) {
    if (!node.data.inlineAgent) continue;
    const c = node.data.inlineAgent;
    node.data.inlineModelSnapshot = JSON.parse(
      JSON.stringify(await modelSnapshot(c.modelId, workspaceId, c)),
    );
  }
  return graph;
}
export async function workflowNodeAgent(
  node: WorkflowNode,
  ctx: ToolContext,
  runtime = false,
) {
  if (!node.data.inlineAgent)
    return workflowAgentVersion(node.data.agentVersionId!, ctx, runtime);
  const c = agentConfig.parse(node.data.inlineAgent);
  const model = node.data.inlineModelSnapshot
    ? modelSnapshotSchema.parse(node.data.inlineModelSnapshot)
    : await modelSnapshot(c.modelId, ctx.workspaceId, c);
  validateModelSet(c, model);
  await validateKnowledgeSelection(
    c.rag,
    ctx.workspaceId,
    ctx.organizationId,
    !!ctx.publicAccess,
    !!ctx.publicAccess,
  );
  if (runtime) await availableAgentTools(c, ctx);
  else {
    await validateToolIds(c.tools.toolIds, ctx);
    await validateSkillSelection(c.skills, ctx);
  }
  const conn = await connection(model, ctx.workspaceId, ctx.organizationId);
  return { c, model, conn };
}
export async function executeWorkflowNodeAgent(
  node: WorkflowNode,
  input: string,
  ctx: ToolContext,
  signal: AbortSignal,
  providerOverride?: ProviderFactory,
  embeddingOverride?: EmbeddingFactory,
) {
  if (!node.data.inlineAgent)
    return executeWorkflowAgent(
      node.data.agentVersionId!,
      input,
      ctx,
      signal,
      providerOverride,
      embeddingOverride,
    );
  const { c, model } = await workflowNodeAgent(node, ctx, true);
  return observe(
    "workflow.agent",
    "agent",
    { "workflow.node.id": node.id },
    () =>
      executeAgentSnapshot(
        c,
        model,
        input,
        ctx,
        signal,
        providerOverride,
        embeddingOverride,
      ),
  );
}
