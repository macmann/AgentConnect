"use client";
import type { WorkflowDefinitionV2 } from "@agentconnect/schemas/workflow-v2";
import type { WorkflowAction } from "@agentconnect/schemas/workflow-actions";
import type { WorkflowExpression } from "@agentconnect/schemas/workflow-values";
import {
  FieldPicker,
  SchemaEditor,
  WorkflowMappings,
  type ValueSchema,
} from "./workflow-v2-fields";
import {
  WorkflowActionConnections,
  type ActionConnectionCatalog,
} from "./workflow-action-connections";
import { Button } from "./button";
type ActionNode = Extract<
  WorkflowDefinitionV2["execution"]["nodes"][number],
  { kind: "action" }
>;
export function WorkflowDirectActionEditor({
  workspaceId,
  canManage,
  node,
  definition,
  connections,
  onChange,
}: {
  workspaceId: string;
  canManage: boolean;
  node: ActionNode;
  definition: WorkflowDefinitionV2;
  connections?: ActionConnectionCatalog;
  onChange: (definition: WorkflowDefinitionV2) => void;
}) {
  const e = definition.execution,
    action = e.actions.find((a) => a.id === node.config.actionId)!;
  const set = (patch: Partial<WorkflowAction>) =>
    onChange({
      ...definition,
      execution: {
        ...e,
        actions: e.actions.map((a) =>
          a.id === action.id ? { ...a, ...patch } : a,
        ),
      },
    });
  const server = connections?.mcp.find((c) => c.id === action.connectionId),
    operation = server?.operations.find((o) => o.name === action.operation),
    httpConnection = connections?.http.find(
      (c) => c.id === action.connectionId,
    );
  const keySupported =
    action.connector === "agentconnect.http"
      ? httpConnection?.idempotency_supported
      : !!operation?.idempotencyArgument;
  const picker = (
    expression: WorkflowExpression,
    change: (v: WorkflowExpression) => void,
  ) => (
    <FieldPicker
      allowArguments
      definition={definition}
      nodeId={node.id}
      value={expression}
      onChange={change}
    />
  );
  return (
    <div>
      <label>
        Action name
        <input
          value={action.name}
          onChange={(event) => set({ name: event.target.value })}
        />
      </label>
      <label>
        Description
        <textarea
          value={action.description}
          onChange={(event) => set({ description: event.target.value })}
        />
      </label>
      <label>
        Action executor
        <select
          aria-label="Action executor"
          value={action.connector}
          onChange={(event) => {
            if (event.target.value === "agentconnect.http")
              set({
                connector: "agentconnect.http",
                operation: "GET",
                http: {
                  method: "GET",
                  url: { type: "literal", value: "" },
                  headers: {},
                  query: {},
                },
                connectionId: undefined,
                sideEffect: "read",
                riskLevel: "low",
                allowSideEffects: false,
                idempotency: "not-required",
                idempotencyArgument: undefined,
                inputSchema: { type: "object" },
                outputSchema: {},
                retry: { maxAttempts: 1, delayMs: 1000 },
              });
            else {
              const s = connections?.mcp.find(
                (c) => c.enabled && c.operations.some((o) => o.allowed),
              );
              const o = s?.operations.find((o) => o.allowed);
              if (s && o)
                set({
                  connector: "agentconnect.mcp-operation",
                  operation: o.name,
                  http: undefined,
                  connectionId: s.id,
                  sideEffect: o.sideEffect,
                  riskLevel: o.riskLevel,
                  allowSideEffects: o.sideEffect !== "read",
                  idempotency: o.idempotency,
                  idempotencyArgument: o.idempotencyArgument,
                  inputSchema: o.inputSchema as never,
                  outputSchema: o.outputSchema as never,
                  retry: { maxAttempts: 1, delayMs: 1000 },
                });
            }
          }}
        >
          <option value="agentconnect.http">Generic HTTP request</option>
          <option value="agentconnect.mcp-operation">
            MCP operation / database integration
          </option>
        </select>
      </label>
      {action.connector === "agentconnect.http" && action.http && (
        <>
          <label>
            HTTP method
            <select
              aria-label="HTTP method"
              value={action.http.method}
              onChange={(event) => {
                const method = event.target.value as NonNullable<
                    WorkflowAction["http"]
                  >["method"],
                  sideEffect =
                    method === "GET"
                      ? "read"
                      : method === "DELETE"
                        ? "delete"
                        : "write";
                set({
                  operation: method,
                  http: {
                    ...action.http!,
                    method,
                    body: method === "GET" ? undefined : action.http?.body,
                  },
                  sideEffect,
                  riskLevel:
                    sideEffect === "read"
                      ? "low"
                      : method === "DELETE"
                        ? "high"
                        : "medium",
                  allowSideEffects: false,
                  idempotency:
                    sideEffect === "read" ? "not-required" : "unsupported",
                  retry: { maxAttempts: 1, delayMs: 1000 },
                });
              }}
            >
              {["GET", "POST", "PUT", "PATCH", "DELETE"].map((method) => (
                <option key={method}>{method}</option>
              ))}
            </select>
          </label>
          <label>
            Authentication connection
            <select
              aria-label="HTTP authentication connection"
              value={action.connectionId ?? ""}
              onChange={(event) => {
                const c = connections?.http.find(
                  (c) => c.id === event.target.value,
                );
                set({
                  connectionId: event.target.value || undefined,
                  http: {
                    ...action.http!,
                    url:
                      action.http!.url.type === "literal" &&
                      !action.http!.url.value &&
                      c
                        ? { type: "literal", value: c.base_url }
                        : action.http!.url,
                  },
                  idempotency:
                    action.sideEffect === "read"
                      ? "not-required"
                      : "unsupported",
                  retry: { maxAttempts: 1, delayMs: 1000 },
                });
              }}
            >
              <option value="">No authentication</option>
              {connections?.http
                .filter(
                  (c) => c.enabled && c.methods.includes(action.http!.method),
                )
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} · {c.auth}
                  </option>
                ))}
            </select>
          </label>
          {action.connectionId && !httpConnection && (
            <p role="alert">The saved connection is unavailable.</p>
          )}
          <h4>Request URL</h4>
          {action.http.url.type === "literal" &&
          typeof action.http.url.value === "string" ? (
            <label>
              URL
              <input
                aria-label="HTTP URL"
                value={action.http.url.value}
                placeholder="https://api.example.com/invoices"
                onChange={(event) =>
                  set({
                    http: {
                      ...action.http!,
                      url: { type: "literal", value: event.target.value },
                    },
                  })
                }
              />
            </label>
          ) : (
            picker(action.http.url, (url) =>
              set({ http: { ...action.http!, url } }),
            )
          )}
          <Button
            onClick={() =>
              set({
                http: {
                  ...action.http!,
                  url:
                    action.http!.url.type === "literal"
                      ? { type: "reference", path: "input.url" }
                      : { type: "literal", value: "" },
                },
              })
            }
          >
            {action.http.url.type === "literal"
              ? "Map URL from a field"
              : "Use static URL"}
          </Button>
          <p>
            Credentials come from the saved connection and are restricted to its
            origin and path prefix.
          </p>
          <details>
            <summary>Request headers</summary>
            <WorkflowMappings
              allowHyphens
              fields={action.http.headers}
              definition={definition}
              nodeId={node.id}
              onChange={(headers) =>
                set({ http: { ...action.http!, headers } })
              }
            />
            <p>Authentication headers are managed by the connection.</p>
          </details>
          <details>
            <summary>Query parameters</summary>
            <WorkflowMappings
              allowHyphens
              fields={action.http.query}
              definition={definition}
              nodeId={node.id}
              onChange={(query) => set({ http: { ...action.http!, query } })}
            />
          </details>
          {action.http.method !== "GET" && (
            <details open>
              <summary>JSON request body</summary>
              {action.http.body ? (
                picker(action.http.body, (body) =>
                  set({ http: { ...action.http!, body } }),
                )
              ) : (
                <Button
                  onClick={() =>
                    set({
                      http: {
                        ...action.http!,
                        body: { type: "literal", value: {} },
                      },
                    })
                  }
                >
                  Add JSON body
                </Button>
              )}
              {action.http.body && (
                <Button
                  onClick={() =>
                    set({ http: { ...action.http!, body: undefined } })
                  }
                >
                  Remove body
                </Button>
              )}
            </details>
          )}
        </>
      )}
      {action.connector === "agentconnect.mcp-operation" && (
        <>
          <label>
            MCP connection
            <select
              aria-label="MCP Action connection"
              value={action.connectionId ?? ""}
              onChange={(event) => {
                const s = connections?.mcp.find(
                    (c) => c.id === event.target.value,
                  ),
                  o = s?.operations.find((o) => o.allowed);
                if (s && o)
                  set({
                    connectionId: s.id,
                    operation: o.name,
                    description: o.description,
                    inputSchema: o.inputSchema as never,
                    outputSchema: o.outputSchema as never,
                    sideEffect: o.sideEffect,
                    riskLevel: o.riskLevel,
                    idempotency: o.idempotency,
                    idempotencyArgument: o.idempotencyArgument,
                    allowSideEffects: false,
                    retry: { maxAttempts: 1, delayMs: 1000 },
                  });
              }}
            >
              <option value="">Choose existing MCP server</option>
              {connections?.mcp
                .filter((s) => s.enabled)
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
            </select>
          </label>
          <label>
            MCP operation
            <select
              aria-label="MCP Action operation"
              value={action.operation}
              onChange={(event) => {
                const o = server?.operations.find(
                  (o) => o.name === event.target.value,
                );
                if (o)
                  set({
                    operation: o.name,
                    name: o.name,
                    description: o.description,
                    inputSchema: o.inputSchema as never,
                    outputSchema: o.outputSchema as never,
                    sideEffect: o.sideEffect,
                    riskLevel: o.riskLevel,
                    idempotency: o.idempotency,
                    idempotencyArgument: o.idempotencyArgument,
                    allowSideEffects: false,
                    retry: { maxAttempts: 1, delayMs: 1000 },
                  });
              }}
            >
              <option value="">Choose a discovered operation</option>
              {server?.operations.map((o) => (
                <option key={o.name} value={o.name} disabled={!o.allowed}>
                  {o.name}
                  {o.allowed ? "" : " · permission required"}
                </option>
              ))}
            </select>
          </label>
          {operation && <p>{operation.description}</p>}
          {!operation?.allowed && (
            <p role="alert">
              An administrator must explicitly allow this operation for workflow
              Actions.
            </p>
          )}
          <p>
            Database operations use this existing MCP connection. No SQL editor
            or Agent Tool is created.
          </p>
        </>
      )}
      <details open={action.connector === "agentconnect.mcp-operation"}>
        <summary>Action inputs</summary>
        <WorkflowMappings
          known={action.inputSchema as ValueSchema}
          fields={{
            ...Object.fromEntries(
              Object.entries(action.staticInputs).map(([key, value]) => [
                key,
                { type: "literal" as const, value },
              ]),
            ),
            ...action.mappedInputs,
            ...node.config.inputs,
          }}
          definition={definition}
          nodeId={node.id}
          onChange={(inputs) =>
            onChange({
              ...definition,
              execution: {
                ...e,
                actions: e.actions.map((a) =>
                  a.id === action.id
                    ? { ...a, staticInputs: {}, mappedInputs: {} }
                    : a,
                ),
                nodes: e.nodes.map((n) =>
                  n.id === node.id
                    ? { ...node, config: { ...node.config, inputs } }
                    : n,
                ),
              },
            })
          }
        />
        <p>Each input may be static or mapped from an earlier step.</p>
        {action.connector === "agentconnect.http" && (
          <SchemaEditor
            value={action.inputSchema as ValueSchema}
            onChange={(schema) => set({ inputSchema: schema as never })}
          />
        )}
      </details>
      <details>
        <summary>Expected output schema</summary>
        <SchemaEditor
          value={action.outputSchema as ValueSchema}
          onChange={(schema) => set({ outputSchema: schema as never })}
        />
      </details>
      <p>
        Side effect: {action.sideEffect} · Risk: {action.riskLevel}
      </p>
      {action.sideEffect !== "read" && (
        <label>
          <input
            type="checkbox"
            checked={action.allowSideEffects}
            onChange={(event) =>
              set({ allowSideEffects: event.target.checked })
            }
          />
          Allow this {action.sideEffect} operation
        </label>
      )}
      <label>
        Risk level
        <select
          value={action.riskLevel}
          onChange={(event) =>
            set({
              riskLevel: event.target.value as WorkflowAction["riskLevel"],
            })
          }
        >
          {["low", "medium", "high"].map((risk) => (
            <option key={risk}>{risk}</option>
          ))}
        </select>
      </label>
      <label>
        Idempotency
        <select
          aria-label="Idempotency"
          value={action.idempotency}
          onChange={(event) =>
            set({
              idempotency: event.target.value as WorkflowAction["idempotency"],
              retry: { ...action.retry, maxAttempts: 1 },
            })
          }
        >
          <option
            value={
              action.sideEffect === "read" ? "not-required" : "unsupported"
            }
          >
            {action.sideEffect === "read" ? "Read operation" : "Not supported"}
          </option>
          <option value="key" disabled={!keySupported}>
            Remote idempotency key
          </option>
        </select>
      </label>
      {action.idempotency === "key" && (
        <p>
          A stable key is sent for retries and checkpoint recovery
          {action.idempotencyArgument
            ? ` through '${action.idempotencyArgument}'`
            : " in Idempotency-Key"}
          . The remote service must honor that contract.
        </p>
      )}
      <label>
        Timeout (ms)
        <input
          type="number"
          min="100"
          max="15000"
          value={action.timeoutMs}
          onChange={(event) => set({ timeoutMs: Number(event.target.value) })}
        />
      </label>
      <label>
        Attempts
        <input
          type="number"
          min="1"
          max={
            action.sideEffect !== "read" && action.idempotency !== "key" ? 1 : 3
          }
          value={action.retry.maxAttempts}
          onChange={(event) =>
            set({
              retry: {
                ...action.retry,
                maxAttempts: Number(event.target.value),
              },
            })
          }
        />
      </label>
      <label>
        Retry delay (ms)
        <input
          type="number"
          min="100"
          max="10000"
          value={action.retry.delayMs}
          onChange={(event) =>
            set({
              retry: { ...action.retry, delayMs: Number(event.target.value) },
            })
          }
        />
      </label>
      <WorkflowActionConnections
        workspaceId={workspaceId}
        canManage={canManage}
      />
      <Button
        onClick={() =>
          onChange({
            ...definition,
            execution: {
              ...e,
              actions: e.actions.filter((a) => a.id !== action.id),
              nodes: e.nodes.map((n) =>
                n.id === node.id
                  ? { ...node, config: { ...node.config, inputs: {} } }
                  : n,
              ),
            },
          })
        }
      >
        Choose an existing Agent Tool instead
      </Button>
    </div>
  );
}
