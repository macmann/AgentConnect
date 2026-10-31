import { config } from "./config.js";
import { randomUUID } from "node:crypto";
import type { WorkflowAction } from "@agentconnect/schemas/workflow-actions";
import {
  resolveWorkflowExpression,
  assertWorkflowValue,
  type WorkflowDataContext,
} from "@agentconnect/schemas/workflow-values";
import { sql } from "./db.js";
import { digest } from "./security.js";
import { workspaceAccess } from "./app.js";
import { schemaValidator } from "./workflow-action-schema.js";
import {
  boundedHttp,
  validateToolUrl,
  validateToolIds,
  toolSecret,
  connectorFor,
  withMcp,
  executeTool,
  redact,
  ToolError,
  type ToolContext,
} from "./tool-runtime.js";
export const canonical = (value: unknown): string =>
  JSON.stringify(value, (_, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, v[k]]),
        )
      : v,
  );
export function capabilityHash(tool: Record<string, unknown>) {
  return digest(
    canonical({
      name: tool.name,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema ?? {},
      annotations: tool.annotations ?? {},
    }),
  );
}
function actionUrl(raw: string) {
  const url = validateToolUrl(raw);
  if ([...url.searchParams.keys()].some((key) => credentialName.test(key)))
    throw new ToolError("ACTION_QUERY_FORBIDDEN");
  return url;
}
export type HttpConnection = {
  id: string;
  base_url: string;
  auth: string;
  secret_id: string | null;
  header_name: string;
  methods: string[];
  idempotency_supported: boolean;
  scopes: string[];
  enabled: boolean;
};
type Grant = {
  enabled: boolean;
  side_effect: string;
  risk_level: string;
  capability_hash: string;
  metadata: Record<string, unknown>;
  idempotency_argument: string | null;
  scopes: string[];
};
const credentialName =
  /authorization|password|token|secret|api.?key|cookie|credential/i;
const blockedHeader =
  /^(host|connection|content-length|transfer-encoding|upgrade|proxy-.*|x-forwarded-.*|forwarded|keep-alive|trailer|te)$/i;
function headerName(key: string) {
  if (
    !/^[A-Za-z][A-Za-z0-9-]{0,79}$/.test(key) ||
    credentialName.test(key) ||
    blockedHeader.test(key)
  )
    throw new ToolError("ACTION_HEADER_FORBIDDEN");
}
export async function httpConnectionFor(id: string, ctx: ToolContext) {
  const [connection] = await sql<
    HttpConnection[]
  >`SELECT * FROM workflow_http_connections WHERE id=${id} AND workspace_id=${ctx.workspaceId} AND organization_id=${ctx.organizationId} AND enabled=true`;
  if (!connection) throw new ToolError("ACTION_CONNECTION_UNAVAILABLE");
  validateToolUrl(connection.base_url);
  return connection;
}
export function connectionAllows(
  connection: HttpConnection,
  target: URL,
  method: string,
) {
  const base = new URL(connection.base_url);
  const prefix = base.pathname.replace(/\/$/, "");
  if (
    target.origin !== base.origin ||
    !(target.pathname === prefix || target.pathname.startsWith(prefix + "/")) ||
    !connection.methods.includes(method) ||
    /%(?:2e|2f|5c|00|25)/i.test(target.pathname) ||
    target.pathname.includes("\\")
  )
    throw new ToolError("ACTION_CONNECTION_MISMATCH");
}
export async function resolveMcpAction(
  action: WorkflowAction,
  ctx: ToolContext,
) {
  if (!action.connectionId) throw new ToolError("ACTION_CONNECTION_REQUIRED");
  const connector = await connectorFor(action.connectionId, ctx);
  validateToolUrl(connector.url);
  const tools = connector.capabilities.tools as
    Record<string, unknown>[] | undefined;
  const metadata = tools?.find((t) => t.name === action.operation);
  if (!metadata) throw new ToolError("ACTION_MCP_OPERATION_UNAVAILABLE");
  const [grant] = await sql<
    Grant[]
  >`SELECT * FROM workflow_mcp_action_grants WHERE connector_id=${connector.id} AND operation=${action.operation} AND workspace_id=${ctx.workspaceId} AND organization_id=${ctx.organizationId}`;
  if (grant && !grant.enabled)
    throw new ToolError("ACTION_MCP_OPERATION_NOT_ALLOWED");
  const annotations = metadata.annotations as
    { readOnlyHint?: boolean; destructiveHint?: boolean } | undefined;
  const effect =
    grant?.side_effect ??
    (annotations?.readOnlyHint === true ? "read" : undefined);
  if (
    !effect ||
    effect !== action.sideEffect ||
    (effect !== "read" && !action.allowSideEffects) ||
    (annotations?.destructiveHint && effect !== "delete")
  )
    throw new ToolError("ACTION_MCP_OPERATION_NOT_ALLOWED");
  if (grant && grant.capability_hash !== capabilityHash(metadata))
    throw new ToolError("ACTION_MCP_CAPABILITY_CHANGED");
  if (
    grant &&
    { low: 0, medium: 1, high: 2 }[action.riskLevel] <
      ({ low: 0, medium: 1, high: 2 }[grant.risk_level as "low"] ?? 2)
  )
    throw new ToolError("ACTION_RISK_MISMATCH");
  if (
    action.idempotencyArgument &&
    action.idempotencyArgument !== grant?.idempotency_argument
  )
    throw new ToolError("ACTION_IDEMPOTENCY_UNSUPPORTED");
  if (action.idempotency === "key" && !grant?.idempotency_argument)
    throw new ToolError("ACTION_IDEMPOTENCY_UNSUPPORTED");
  if (action.requiredScopes.some((s) => !grant?.scopes.includes(s)))
    throw new ToolError("ACTION_SCOPE_UNAVAILABLE");
  schemaValidator(metadata.inputSchema as Record<string, unknown>);
  if (metadata.outputSchema)
    schemaValidator(metadata.outputSchema as Record<string, unknown>);
  return { connector, metadata, grant };
}
export async function validateWorkflowAction(
  action: WorkflowAction,
  ctx: ToolContext,
) {
  if (
    ctx.publicAccess &&
    !["agentconnect.tool", "agentconnect.mcp"].includes(action.connector)
  )
    throw new ToolError("ACTION_NOT_PUBLIC");
  schemaValidator(action.inputSchema);
  schemaValidator(action.outputSchema);
  for (const permission of action.requiredPermissions) {
    if (!ctx.userId) throw new ToolError("ACTION_PERMISSION_REQUIRED");
    await workspaceAccess(ctx.userId, ctx.workspaceId, permission);
  }
  if (
    action.sideEffect !== "read" &&
    (!action.allowSideEffects ||
      action.riskLevel === "low" ||
      (action.retry.maxAttempts > 1 && action.idempotency !== "key"))
  )
    throw new ToolError("ACTION_WRITE_POLICY_REQUIRED");
  if (action.connector === "agentconnect.http") {
    if (!action.http || action.operation !== action.http.method)
      throw new ToolError("ACTION_HTTP_CONFIG_REQUIRED");
    const effect =
      action.http.method === "GET"
        ? "read"
        : action.http.method === "DELETE"
          ? "delete"
          : "write";
    if (effect !== action.sideEffect)
      throw new ToolError("ACTION_SIDE_EFFECT_MISMATCH");
    for (const key of Object.keys(action.http.headers)) headerName(key);
    for (const key of Object.keys(action.http.query))
      if (credentialName.test(key) || /[\r\n]/.test(key))
        throw new ToolError("ACTION_QUERY_FORBIDDEN");
    if (action.http.method === "GET" && action.http.body)
      throw new ToolError("ACTION_GET_BODY_FORBIDDEN");
    const c = action.connectionId
      ? await httpConnectionFor(action.connectionId, ctx)
      : undefined;
    if (c?.secret_id) await toolSecret(c.secret_id, ctx);
    if (c && !c.methods.includes(action.http.method))
      throw new ToolError("ACTION_METHOD_NOT_ALLOWED");
    if (action.idempotency === "key" && !c?.idempotency_supported)
      throw new ToolError("ACTION_IDEMPOTENCY_UNSUPPORTED");
    if (action.requiredScopes.some((s) => !c?.scopes.includes(s)))
      throw new ToolError("ACTION_SCOPE_UNAVAILABLE");
    if (action.http.url.type === "literal") {
      if (typeof action.http.url.value !== "string")
        throw new ToolError("ACTION_URL_INVALID");
      const u = actionUrl(action.http.url.value);
      if (c) connectionAllows(c, u, action.http.method);
    }
    return;
  }
  if (action.connector === "agentconnect.mcp-operation") {
    await resolveMcpAction(action, ctx);
    return;
  }
  if (
    !action.toolId ||
    action.sideEffect !== "read" ||
    action.idempotency === "key" ||
    action.requiredScopes.length
  )
    throw new ToolError("ACTION_EXECUTOR_UNSUPPORTED");
  const [tool] = await validateToolIds([action.toolId], ctx);
  if (!tool) throw new ToolError("TOOL_UNAVAILABLE");
  if (
    (action.connector === "agentconnect.mcp") !==
    (tool.config.kind === "mcp")
  )
    throw new ToolError("ACTION_CONNECTOR_MISMATCH");
  const actual =
    tool.config.kind === "mcp"
      ? tool.config.connectorId
      : "secretId" in tool.config
        ? (tool.config.secretId ?? undefined)
        : undefined;
  if (action.connectionId && action.connectionId !== actual)
    throw new ToolError("ACTION_CONNECTION_MISMATCH");
  const secretId =
    tool.config.kind === "mcp"
      ? (await connectorFor(tool.config.connectorId, ctx)).secret_id
      : "secretId" in tool.config
        ? tool.config.secretId
        : null;
  if (secretId) await toolSecret(secretId, ctx);
}
function value(
  expression: Parameters<typeof resolveWorkflowExpression>[0],
  context: WorkflowDataContext,
) {
  return resolveWorkflowExpression(expression, context);
}
export function resolveActionInputs(
  action: WorkflowAction,
  overrides: WorkflowAction["mappedInputs"],
  context: WorkflowDataContext,
) {
  const args = {
    ...action.staticInputs,
    ...Object.fromEntries(
      Object.entries({ ...action.mappedInputs, ...overrides }).map(
        ([key, expression]) => [key, value(expression, context)],
      ),
    ),
  };
  assertWorkflowValue(args);
  if (Buffer.byteLength(JSON.stringify(args)) > 128000)
    throw new ToolError("ACTION_INPUT_LIMIT");
  return args;
}
async function executeResolvedWorkflowAction(
  action: WorkflowAction,
  supplied: Record<string, unknown>,
  ctx: ToolContext,
  signal: AbortSignal,
  workflowContext?: WorkflowDataContext,
) {
  await validateWorkflowAction(action, ctx);
  if (!ctx.workflowRunId || !ctx.workflowNodeId)
    throw new ToolError("ACTION_CONTEXT_REQUIRED");
  const args = { ...supplied };
  const context: WorkflowDataContext = {
    trigger: {},
    input: {},
    steps: {},
    variables: {},
    workflow: {},
    error: {},
    ...workflowContext,
    arguments: args,
  };
  const keyValue = action.idempotencyKey
    ? value(action.idempotencyKey, context)
    : `${ctx.workflowRunId}:${ctx.workflowNodeId}:${action.id}`;
  if (typeof keyValue !== "string" || !keyValue || keyValue.length > 512)
    throw new ToolError("ACTION_IDEMPOTENCY_KEY_INVALID");
  const remoteKey =
    "ac-" +
    digest(
      `${ctx.workspaceId}:${ctx.workflowId ?? ""}:${action.id}:${action.connectionId ?? action.toolId ?? "http"}:${action.operation}:${action.http ? String(value(action.http.url, context)) : ""}:${keyValue}`,
    );
  const mcp =
    action.connector === "agentconnect.mcp-operation"
      ? await resolveMcpAction(action, ctx)
      : undefined;
  if (action.idempotency === "key" && mcp?.grant?.idempotency_argument)
    args[mcp.grant.idempotency_argument] = remoteKey;
  if (!schemaValidator(action.inputSchema)(args))
    throw new ToolError("ACTION_INPUT_INVALID");
  if (
    mcp &&
    !schemaValidator(mcp.metadata.inputSchema as Record<string, unknown>)(args)
  )
    throw new ToolError("ACTION_MCP_INPUT_INVALID");
  const connection =
    action.connector === "agentconnect.http" && action.connectionId
      ? await httpConnectionFor(action.connectionId, ctx)
      : undefined;
  const secretId = connection?.secret_id ?? mcp?.connector.secret_id;
  const secret = secretId ? await toolSecret(secretId, ctx) : undefined;
  const secrets = secret
    ? [secret, Buffer.from(secret).toString("base64"), `Bearer ${secret}`]
    : [];
  const request = action.http
    ? {
        url: value(action.http.url, context),
        headers: Object.fromEntries(
          Object.entries(action.http.headers).map(([key, expression]) => [
            key,
            value(expression, context),
          ]),
        ),
        query: Object.fromEntries(
          Object.entries(action.http.query).map(([key, expression]) => [
            key,
            value(expression, context),
          ]),
        ),
        body: action.http.body ? value(action.http.body, context) : null,
      }
    : null;
  const fingerprint = digest(canonical({ action, args, request }));
  const safeReplay =
    action.sideEffect === "read" || action.idempotency === "key";
  type Execution = {
    id: string;
    attempts: number;
    status: string;
    input_fingerprint: string;
    result: unknown;
    cached?: boolean;
    unknown?: boolean;
  };
  const execution: Execution = await sql.begin(async (tx) => {
    await tx`INSERT INTO workflow_action_executions(id,run_id,node_id,workspace_id,organization_id,action_id,connector,operation,connection_id,side_effect,risk_level,idempotency,input_fingerprint,status) VALUES (${randomUUID()},${ctx.workflowRunId!},${ctx.workflowNodeId!},${ctx.workspaceId},${ctx.organizationId},${action.id},${action.connector},${action.operation},${action.connectionId ?? null},${action.sideEffect},${action.riskLevel},${action.idempotency},${fingerprint},'running') ON CONFLICT(run_id,node_id) DO NOTHING`;
    const [row] = await tx<
      Execution[]
    >`SELECT * FROM workflow_action_executions WHERE run_id=${ctx.workflowRunId!} AND node_id=${ctx.workflowNodeId!} FOR UPDATE`;
    if (row!.input_fingerprint !== fingerprint)
      throw new ToolError("ACTION_IDEMPOTENCY_CONFLICT");
    if (row!.status === "completed") return { cached: true, ...row! };
    if (!safeReplay && row!.attempts > 0) {
      await tx`UPDATE workflow_action_executions SET status='uncertain',error_code='ACTION_OUTCOME_UNKNOWN' WHERE id=${row!.id}`;
      return { unknown: true, ...row! };
    }
    await tx`UPDATE workflow_action_attempts SET status='interrupted',error_code='ACTION_ATTEMPT_INTERRUPTED',finished_at=now() WHERE execution_id=${row!.id} AND status='running'`;
    const [current] = await tx<
      Execution[]
    >`UPDATE workflow_action_executions SET attempts=attempts+1,status='running',error_code=NULL WHERE id=${row!.id} RETURNING *`;
    await tx`INSERT INTO workflow_action_attempts(id,execution_id,attempt,status) VALUES (${randomUUID()},${row!.id},${current!.attempts},'running')`;
    return { ...current! };
  });
  if (execution.unknown) throw new ToolError("ACTION_OUTCOME_UNKNOWN");
  if (execution.cached) return execution.result;
  const started = performance.now(),
    timeout = AbortSignal.timeout(action.timeoutMs),
    combined = AbortSignal.any([signal, timeout]);
  let invoked = false;
  try {
    combined.throwIfAborted();
    let result: unknown;
    if (action.connector === "agentconnect.http") {
      const http = action.http!,
        rawUrl = value(http.url, context);
      if (typeof rawUrl !== "string") throw new ToolError("ACTION_URL_INVALID");
      const url = actionUrl(rawUrl);
      if (connection) connectionAllows(connection, url, http.method);
      for (const [key, expression] of Object.entries(http.query)) {
        const entry = value(expression, context);
        for (const v of Array.isArray(entry) ? entry : [entry]) {
          if (v === null) continue;
          if (!["string", "number", "boolean"].includes(typeof v))
            throw new ToolError("ACTION_QUERY_INVALID");
          url.searchParams.append(key, String(v));
        }
      }
      const headers: Record<string, string> = {
        "content-type": "application/json",
      };
      for (const [key, expression] of Object.entries(http.headers)) {
        headerName(key);
        const v = value(expression, context);
        if (
          typeof v !== "string" ||
          /[\r\n]/.test(v) ||
          v.length > 2000 ||
          (key.toLowerCase() === "content-type" && v !== "application/json")
        )
          throw new ToolError("ACTION_HEADER_INVALID");
        headers[key.toLowerCase()] = v;
      }
      if (connection && secret) {
        if (connection.auth === "bearer")
          headers.authorization = `Bearer ${secret}`;
        else if (connection.auth === "basic")
          headers.authorization = `Basic ${Buffer.from(secret).toString("base64")}`;
        else if (connection.auth === "api-key")
          headers[connection.header_name.toLowerCase()] = secret;
      }
      if (action.idempotency === "key") headers["idempotency-key"] = remoteKey;
      const body = http.body ? value(http.body, context) : undefined;
      if (
        body !== undefined &&
        Buffer.byteLength(JSON.stringify(body)) > 128000
      )
        throw new ToolError("ACTION_INPUT_LIMIT");
      invoked = true;
      const response = await boundedHttp(
        url.href,
        headers,
        body,
        combined,
        http.method,
        config.WORKFLOW_ACTION_RESPONSE_BYTES,
      );
      if (response.status < 200 || response.status >= 300)
        throw new ToolError(
          `ACTION_HTTP_${response.status}`,
          response.status === 429 || response.status >= 500,
        );
      if (response.status === 204 || !response.text.trim()) result = null;
      else {
        try {
          result = JSON.parse(response.text);
        } catch {
          result = response.text;
        }
      }
    } else if (mcp) {
      result = await withMcp(
        mcp.connector,
        ctx,
        combined,
        async (client) => {
          const listing = await client.listTools(
            {},
            { signal: combined, timeout: action.timeoutMs },
          );
          const current = listing.tools.find(
            (t) => t.name === action.operation,
          );
          if (
            !current ||
            capabilityHash(current as unknown as Record<string, unknown>) !==
              capabilityHash(mcp.metadata)
          )
            throw new ToolError("ACTION_MCP_CAPABILITY_CHANGED");
          invoked = true;
          const response = await client.callTool(
            { name: action.operation, arguments: args },
            undefined,
            { signal: combined, timeout: action.timeoutMs },
          );
          if (response.isError) throw new ToolError("ACTION_MCP_REMOTE_ERROR");
          if (response.structuredContent !== undefined)
            return response.structuredContent;
          const content = response.content as { type: string; text?: string }[];
          if (content?.length === 1 && content[0]?.type === "text") {
            try {
              return JSON.parse(content[0].text!);
            } catch {
              /* Retain protocol result for non-JSON text. */
            }
          }
          return response;
        },
        { value: secret ?? null },
      );
      if (
        mcp.metadata.outputSchema &&
        !schemaValidator(mcp.metadata.outputSchema as Record<string, unknown>)(
          result,
        )
      )
        throw new ToolError("ACTION_MCP_OUTPUT_INVALID");
    } else {
      invoked = true;
      result = (await executeTool(action.toolId!, args, ctx, combined)).result;
    }
    result = redact(result, secrets);
    assertWorkflowValue(result);
    if (
      Buffer.byteLength(JSON.stringify(result)) > config.WORKFLOW_OUTPUT_BYTES
    )
      throw new ToolError("ACTION_OUTPUT_LIMIT");
    if (!schemaValidator(action.outputSchema)(result))
      throw new ToolError("ACTION_OUTPUT_INVALID");
    combined.throwIfAborted();
    const duration = Math.round(performance.now() - started);
    await sql.begin(async (tx) => {
      const changed =
        await tx`UPDATE workflow_action_executions SET status='completed',result=${tx.json(result as never)},duration_ms=${duration},finished_at=now() WHERE id=${execution.id} AND attempts=${execution.attempts} RETURNING id`;
      if (!changed.length) throw new ToolError("ACTION_EXECUTION_SUPERSEDED");
      await tx`UPDATE workflow_action_attempts SET status='completed',duration_ms=${duration},finished_at=now() WHERE execution_id=${execution.id} AND attempt=${execution.attempts}`;
    });
    return result;
  } catch (error) {
    const unknown = invoked && !safeReplay;
    const code = unknown
      ? "ACTION_OUTCOME_UNKNOWN"
      : signal.aborted
        ? "ACTION_CANCELLED"
        : timeout.aborted
          ? "ACTION_TIMEOUT"
          : error instanceof ToolError
            ? error.code
            : "ACTION_EXECUTION_FAILED";
    const duration = Math.round(performance.now() - started);
    await sql.begin(async (tx) => {
      const changed =
        await tx`UPDATE workflow_action_executions SET status=${unknown ? "uncertain" : "failed"},error_code=${code},duration_ms=${duration},finished_at=now() WHERE id=${execution.id} AND attempts=${execution.attempts} RETURNING id`;
      if (changed.length)
        await tx`UPDATE workflow_action_attempts SET status=${unknown ? "uncertain" : "failed"},error_code=${code},duration_ms=${duration},finished_at=now() WHERE execution_id=${execution.id} AND attempt=${execution.attempts}`;
    });
    throw new ToolError(
      code,
      !unknown &&
        !signal.aborted &&
        (timeout.aborted || (error instanceof ToolError && error.retryable)),
    );
  }
}

async function recordPreflightFailure(
  action: WorkflowAction,
  ctx: ToolContext,
  code: string,
) {
  if (!ctx.workflowRunId || !ctx.workflowNodeId) return;
  await sql.begin(async (tx) => {
    const [row] =
      await tx`INSERT INTO workflow_action_executions(id,run_id,node_id,workspace_id,organization_id,action_id,connector,operation,connection_id,side_effect,risk_level,idempotency,input_fingerprint,status,attempts,error_code,duration_ms,finished_at) VALUES (${randomUUID()},${ctx.workflowRunId!},${ctx.workflowNodeId!},${ctx.workspaceId},${ctx.organizationId},${action.id},${action.connector},${action.operation},${action.connectionId ?? null},${action.sideEffect},${action.riskLevel},${action.idempotency},${digest(canonical(action))},'failed',1,${code},0,now()) ON CONFLICT(run_id,node_id) DO NOTHING RETURNING id`;
    if (row)
      await tx`INSERT INTO workflow_action_attempts(id,execution_id,attempt,status,error_code,duration_ms,finished_at) VALUES (${randomUUID()},${row.id},1,'failed',${code},0,now())`;
  });
}
export async function executeWorkflowAction(
  action: WorkflowAction,
  args: Record<string, unknown>,
  ctx: ToolContext,
  signal: AbortSignal,
  context?: WorkflowDataContext,
) {
  try {
    return await executeResolvedWorkflowAction(
      action,
      args,
      ctx,
      signal,
      context,
    );
  } catch (error) {
    const code =
      error instanceof ToolError ? error.code : "ACTION_EXECUTION_FAILED";
    await recordPreflightFailure(action, ctx, code);
    if (error instanceof ToolError) throw error;
    throw new ToolError(code);
  }
}
export async function executeWorkflowNodeAction(
  action: WorkflowAction,
  overrides: WorkflowAction["mappedInputs"],
  context: WorkflowDataContext,
  ctx: ToolContext,
  signal: AbortSignal,
) {
  let args: Record<string, unknown>;
  try {
    args = resolveActionInputs(action, overrides, context);
  } catch (error) {
    const code =
      error instanceof Error &&
      "code" in error &&
      typeof error.code === "string" &&
      /^[A-Z][A-Z0-9_]{0,80}$/.test(error.code)
        ? error.code
        : "ACTION_INPUT_RESOLUTION_FAILED";
    await recordPreflightFailure(action, ctx, code);
    throw new ToolError(code);
  }
  return executeWorkflowAction(action, args, ctx, signal, context);
}
