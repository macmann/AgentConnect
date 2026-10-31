"use client";
import type { WorkflowDefinitionV2 } from "@agentconnect/schemas/workflow-v2";
import { workflowAction } from "@agentconnect/schemas/workflow-actions";
import { workflowCondition } from "@agentconnect/schemas/workflow-values";
import type { WorkflowExpression } from "@agentconnect/schemas/workflow-values";
import {
  defaultValue,
  FieldPicker,
  SchemaEditor,
  type ValueSchema,
} from "./workflow-v2-fields";
import { WorkflowInputEditor } from "./workflow-inputs";
import { resourceHref } from "./workflow-resource-picker";
import { Button } from "./button";
import { useState } from "react";
export type WorkflowCatalog = {
  workflows?: {
    id: string;
    workflow_id: string;
    name: string;
    version: number;
  }[];
  agents: {
    id: string;
    agent_id: string;
    name: string;
    version: number;
    public_description?: string;
    provider?: string;
    model?: string;
    knowledge_count?: number;
    tool_count?: number;
  }[];
  models: { id: string; name: string; provider: string; model_id: string }[];
  actions: {
    id: string;
    name: string;
    unavailable?: boolean;
    connector: "agentconnect.tool" | "agentconnect.mcp";
    operation: "execute";
    connectionId?: string;
    inputSchema: Record<string, never>;
    timeoutMs: number;
  }[];
};
type V2Node = WorkflowDefinitionV2["execution"]["nodes"][number];
const ref = (path: string): WorkflowExpression => ({ type: "reference", path });
function Mappings({
  fields,
  definition,
  nodeId,
  onChange,
  known,
}: {
  fields: Record<string, WorkflowExpression>;
  definition: WorkflowDefinitionV2;
  nodeId: string;
  onChange: (f: Record<string, WorkflowExpression>) => void;
  known?: ValueSchema;
}) {
  const [name, setName] = useState("");
  return (
    <div>
      {Object.entries(fields).map(([key, value]) => (
        <details key={key} open>
          <summary>
            {key}
            {known?.properties?.[key]?.type
              ? ` · ${known.properties[key].type}`
              : ""}
          </summary>
          <FieldPicker
            definition={definition}
            nodeId={nodeId}
            value={value}
            onChange={(v) => onChange({ ...fields, [key]: v })}
          />
          <Button
            onClick={() =>
              onChange(
                Object.fromEntries(
                  Object.entries(fields).filter(([k]) => k !== key),
                ),
              )
            }
          >
            Remove {key}
          </Button>
        </details>
      ))}
      <div className="v2-inline">
        {known?.properties ? (
          <select
            aria-label="Input field to map"
            value={name}
            onChange={(e) => setName(e.target.value)}
          >
            <option value="">Choose input field</option>
            {Object.keys(known.properties)
              .filter((k) => !Object.hasOwn(fields, k))
              .map((k) => (
                <option key={k}>{k}</option>
              ))}
          </select>
        ) : (
          <input
            aria-label="Output field name"
            placeholder="Field name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        )}
        <Button
          disabled={
            !/^[A-Za-z][A-Za-z0-9_]{0,47}$/.test(name) ||
            ["constructor", "prototype", "__proto__"].includes(name) ||
            Object.hasOwn(fields, name)
          }
          onClick={() => {
            onChange({
              ...fields,
              [name]: {
                type: "literal",
                value: defaultValue(
                  known?.properties?.[name] ?? { type: "string" },
                ) as never,
              },
            });
            setName("");
          }}
        >
          + Mapping
        </Button>
      </div>
    </div>
  );
}
export function WorkflowV2NodePanel({
  node,
  workspaceId,
  definition,
  catalog,
  onChange,
}: {
  node: V2Node;
  workspaceId: string;
  definition: WorkflowDefinitionV2;
  catalog?: WorkflowCatalog;
  onChange: (definition: WorkflowDefinitionV2) => void;
}) {
  const [waitUnit, setWaitUnit] = useState(1);
  const [connectorFilter, setConnectorFilter] = useState("");
  const e = definition.execution;
  const change = (config: V2Node["config"]) =>
    onChange({
      ...definition,
      execution: {
        ...e,
        nodes: e.nodes.map((n) =>
          n.id === node.id ? ({ ...node, config } as V2Node) : n,
        ),
      },
    });
  const resource =
    "resource" in node.config ? e.resources[node.config.resource] : undefined;
  const input = "input" in node.config ? node.config.input : undefined;
  const picker = (
    value: WorkflowExpression,
    set: (v: WorkflowExpression) => void,
  ) => (
    <FieldPicker
      definition={definition}
      nodeId={node.id}
      value={value}
      onChange={set}
    />
  );
  return (
    <div className="v2-node-config">
      <label>
        Step name
        <input
          value={node.label}
          onChange={(event) =>
            onChange({
              ...definition,
              execution: {
                ...e,
                nodes: e.nodes.map((n) =>
                  n.id === node.id ? { ...n, label: event.target.value } : n,
                ),
              },
            })
          }
        />
      </label>
      <small>{node.kind}</small>
      {node.kind === "input" && (
        <WorkflowInputEditor
          disabled={false}
          fields={e.inputFields}
          onChange={(inputFields) =>
            onChange({ ...definition, execution: { ...e, inputFields } })
          }
        />
      )}
      {node.kind === "agent" && (
        <>
          <label>
            Agent
            <select
              aria-label="Agent"
              value={resource?.kind === "agent" ? resource.agentId : ""}
              onChange={(event) => {
                const agent = catalog?.agents.find(
                  (a) => a.agent_id === event.target.value,
                );
                if (agent)
                  onChange({
                    ...definition,
                    execution: {
                      ...e,
                      resources: {
                        ...e.resources,
                        [node.config.resource]: {
                          kind: "agent",
                          agentId: agent.agent_id,
                          versionId: agent.id,
                        },
                      },
                    },
                  });
              }}
            >
              <option value="">Choose existing Agent</option>
              {catalog?.agents
                .filter(
                  (a, i, all) =>
                    all.findIndex((b) => b.agent_id === a.agent_id) === i,
                )
                .map((a) => (
                  <option key={a.agent_id} value={a.agent_id}>
                    {a.name}
                  </option>
                ))}
            </select>
          </label>
          <label>
            Published version
            <select
              aria-label="Published version"
              value={resource?.kind === "agent" ? resource.versionId : ""}
              onChange={(event) => {
                const agent = catalog?.agents.find(
                  (a) => a.id === event.target.value,
                );
                if (agent)
                  onChange({
                    ...definition,
                    execution: {
                      ...e,
                      resources: {
                        ...e.resources,
                        [node.config.resource]: {
                          kind: "agent",
                          agentId: agent.agent_id,
                          versionId: agent.id,
                        },
                      },
                    },
                  });
              }}
            >
              <option value="">Choose version</option>
              {catalog?.agents
                .filter(
                  (a) =>
                    resource?.kind === "agent" &&
                    a.agent_id === resource.agentId,
                )
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    Version {a.version}
                  </option>
                ))}
            </select>
          </label>
          {resource?.kind === "agent" &&
            (() => {
              const metadata = catalog?.agents.find(
                (a) => a.id === resource.versionId,
              );
              return metadata ? (
                <div className="configure-group">
                  <p>{metadata.public_description || metadata.name}</p>
                  <small>
                    Published v{metadata.version} · {metadata.provider} /{" "}
                    {metadata.model}
                    <br />
                    {metadata.knowledge_count ?? 0} knowledge bases ·{" "}
                    {metadata.tool_count ?? 0} tools
                  </small>
                </div>
              ) : null;
            })()}
          <p>
            Uses the selected published Agent’s prompts, model, tools and
            knowledge. Configure these in Agents.
          </p>
          <a
            href={`/#${new URLSearchParams({ workspace: workspaceId, view: "Agents", ...(resource?.kind === "agent" ? { agent: resource.agentId } : {}) })}`}
            target="_blank"
            rel="noreferrer"
          >
            Open Agents
          </a>
        </>
      )}
      {node.kind === "structured-ai" && (
        <>
          <label>
            Model / provider
            <select
              value={resource?.kind === "model" ? resource.id : ""}
              onChange={(event) =>
                onChange({
                  ...definition,
                  execution: {
                    ...e,
                    resources: {
                      ...e.resources,
                      [node.config.resource]: {
                        kind: "model",
                        id: event.target.value,
                      },
                    },
                  },
                })
              }
            >
              <option value="">Choose configured model</option>
              {catalog?.models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} · {m.provider} / {m.model_id}
                </option>
              ))}
            </select>
          </label>
          <label>
            Instructions
            <textarea
              value={node.config.instruction}
              onChange={(event) =>
                change({ ...node.config, instruction: event.target.value })
              }
            />
          </label>
          <h4>Structured output</h4>
          <SchemaEditor
            value={node.config.outputSchema as ValueSchema}
            onChange={(s) =>
              change({ ...node.config, outputSchema: s as never })
            }
          />
        </>
      )}
      {node.kind === "action" &&
        (() => {
          const action = e.actions.find((a) => a.id === node.config.actionId);
          const set = (patch: Partial<NonNullable<typeof action>>) => {
            if (action)
              onChange({
                ...definition,
                execution: {
                  ...e,
                  actions: e.actions.map((a) =>
                    a.id === action.id ? { ...a, ...patch } : a,
                  ),
                },
              });
          };
          return (
            <>
              <label>
                Connector
                <select
                  aria-label="Action connector"
                  value={connectorFilter}
                  onChange={(event) => setConnectorFilter(event.target.value)}
                >
                  <option value="">All connectors</option>
                  <option value="agentconnect.tool">Registered Tool</option>
                  <option value="agentconnect.mcp">MCP server</option>
                </select>
              </label>
              <label>
                Integration / operation
                <select
                  value={action?.toolId ?? ""}
                  onChange={(event) => {
                    const selected = catalog?.actions.find(
                      (a) => a.id === event.target.value,
                    );
                    if (selected) {
                      const a = workflowAction.parse({
                        id: node.config.actionId,
                        name: selected.name,
                        toolId: selected.id,
                        connector: selected.connector,
                        operation: selected.operation,
                        connectionId: selected.connectionId,
                        inputSchema: selected.inputSchema,
                        timeoutMs: selected.timeoutMs,
                      });
                      onChange({
                        ...definition,
                        execution: {
                          ...e,
                          actions: [
                            ...e.actions.filter((old) => old.id !== a.id),
                            a,
                          ],
                        },
                      });
                    }
                  }}
                >
                  <option value="">Choose registered operation</option>
                  {catalog?.actions
                    .filter(
                      (a) =>
                        !a.unavailable &&
                        (!connectorFilter || a.connector === connectorFilter),
                    )
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name} · execute
                      </option>
                    ))}
                </select>
              </label>
              {!catalog?.actions.some((a) => !a.unavailable) && (
                <p>
                  No available Actions.{" "}
                  <a
                    href={resourceHref(
                      workspaceId,
                      "tools",
                      node.kind === "action"
                        ? e.actions.find((a) => a.id === node.config.actionId)
                            ?.toolId
                        : undefined,
                    )}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Create a Tool / MCP integration
                  </a>
                </p>
              )}
              {action && (
                <>
                  <p>
                    Connector: {action.connector}
                    <br />
                    Operation: {action.operation}
                  </p>
                  <label>
                    Connection
                    <select value={action.connectionId ?? "none"} disabled>
                      <option value={action.connectionId ?? "none"}>
                        {action.connectionId
                          ? "Saved integration connection"
                          : "No connection required"}
                      </option>
                    </select>
                  </label>
                  <a
                    href={resourceHref(
                      workspaceId,
                      "tools",
                      node.kind === "action"
                        ? e.actions.find((a) => a.id === node.config.actionId)
                            ?.toolId
                        : undefined,
                    )}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Configure integration and connection
                  </a>
                  <h4>Inputs</h4>
                  <Mappings
                    fields={{
                      ...Object.fromEntries(
                        Object.entries(action.staticInputs).map(
                          ([key, value]) => [
                            key,
                            { type: "literal" as const, value },
                          ],
                        ),
                      ),
                      ...action.mappedInputs,
                      ...node.config.inputs,
                    }}
                    definition={definition}
                    nodeId={node.id}
                    known={action.inputSchema as ValueSchema}
                    onChange={(inputs) => {
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
                      });
                    }}
                  />
                  <details>
                    <summary>Output schema for downstream mappings</summary>
                    <SchemaEditor
                      value={action.outputSchema as ValueSchema}
                      onChange={(schema) =>
                        set({ outputSchema: schema as never })
                      }
                    />
                  </details>
                  <label>
                    Timeout (ms)
                    <input
                      type="number"
                      min="100"
                      max="15000"
                      value={action.timeoutMs}
                      onChange={(event) =>
                        set({ timeoutMs: Number(event.target.value) })
                      }
                    />
                  </label>
                  <label>
                    Attempts
                    <input
                      type="number"
                      min="1"
                      max="3"
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
                          retry: {
                            ...action.retry,
                            delayMs: Number(event.target.value),
                          },
                        })
                      }
                    />
                  </label>
                </>
              )}
            </>
          );
        })()}
      {node.kind === "human-task" && (
        <>
          <label>
            Review mode
            <select
              value={node.config.mode}
              onChange={(event) =>
                change({
                  ...node.config,
                  mode: event.target.value as "approve-reject" | "review-edit",
                })
              }
            >
              <option value="approve-reject">Approve / reject</option>
              <option value="review-edit">
                Review and edit structured data
              </option>
            </select>
          </label>
          <label>
            Task instructions
            <textarea
              value={node.config.prompt}
              onChange={(event) =>
                change({ ...node.config, prompt: event.target.value })
              }
            />
          </label>
          <label>
            Approve button
            <input
              value={node.config.approveLabel}
              onChange={(event) =>
                change({ ...node.config, approveLabel: event.target.value })
              }
            />
          </label>
          <label>
            Reject button
            <input
              value={node.config.rejectLabel}
              onChange={(event) =>
                change({ ...node.config, rejectLabel: event.target.value })
              }
            />
          </label>
          <SchemaEditor
            value={node.config.outputSchema as ValueSchema}
            onChange={(s) =>
              change({ ...node.config, outputSchema: s as never })
            }
          />
        </>
      )}
      {node.kind === "output" && (
        <>
          <label>
            Result title
            <input
              value={node.config.title}
              onChange={(event) =>
                change({ ...node.config, title: event.target.value })
              }
            />
          </label>
          <label>
            Summary
            <input
              value={node.config.summary}
              onChange={(event) =>
                change({ ...node.config, summary: event.target.value })
              }
            />
          </label>
          <label>
            Display format
            <select
              value={node.config.format}
              onChange={(event) =>
                change({
                  ...node.config,
                  format: event.target.value as "auto" | "text" | "json",
                })
              }
            >
              {["auto", "text", "json"].map((format) => (
                <option key={format}>{format}</option>
              ))}
            </select>
          </label>
        </>
      )}
      {node.kind === "human-task" && (
        <Button
          onClick={() => {
            const previous = e.nodes.find((n) =>
              e.edges.some(
                (edge) => edge.source === n.id && edge.target === node.id,
              ),
            );
            const schema =
              previous?.kind === "structured-ai" ||
              previous?.kind === "human-task"
                ? previous.config.outputSchema
                : previous?.kind === "action"
                  ? e.actions.find((a) => a.id === previous.config.actionId)
                      ?.outputSchema
                  : undefined;
            if (schema) change({ ...node.config, outputSchema: schema });
          }}
        >
          Use previous step’s output schema
        </Button>
      )}
      {node.kind === "approval" && (
        <label>
          Approval prompt
          <textarea
            value={node.config.prompt}
            onChange={(event) =>
              change({ ...node.config, prompt: event.target.value })
            }
          />
        </label>
      )}
      {node.kind === "transform" && (
        <>
          <h4>Build output object</h4>
          <Mappings
            fields={node.config.fields}
            definition={definition}
            nodeId={node.id}
            onChange={(fields) => change({ fields })}
          />
        </>
      )}
      {node.kind === "set-variable" && (
        <>
          <label>
            Variable
            <select
              value={node.config.name}
              onChange={(event) =>
                change({ ...node.config, name: event.target.value })
              }
            >
              <option value="">Choose declared variable</option>
              {Object.keys(e.variables).map((key) => (
                <option key={key}>{key}</option>
              ))}
            </select>
          </label>
          {picker(node.config.value, (value) =>
            change({ ...node.config, value }),
          )}
        </>
      )}
      {(node.kind === "for-each" || node.kind === "subworkflow") && (
        <>
          <label>
            Published workflow / body
            <select
              aria-label="Child workflow version"
              value={
                resource?.kind === "workflow" ? (resource.versionId ?? "") : ""
              }
              onChange={(event) => {
                const selected = catalog?.workflows?.find(
                  (w) => w.id === event.target.value,
                );
                if (selected)
                  onChange({
                    ...definition,
                    execution: {
                      ...e,
                      resources: {
                        ...e.resources,
                        [node.config.resource]: {
                          kind: "workflow",
                          workflowId: selected.workflow_id,
                          versionId: selected.id,
                          versionBehavior: "pinned",
                        },
                      },
                    },
                  });
              }}
            >
              <option value="">Choose published workflow</option>
              {catalog?.workflows?.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name} · v{w.version}
                </option>
              ))}
            </select>
          </label>
          <label>
            Version behavior
            <select
              value={
                resource?.kind === "workflow"
                  ? resource.versionBehavior
                  : "pinned"
              }
              onChange={(event) => {
                if (resource?.kind === "workflow")
                  onChange({
                    ...definition,
                    execution: {
                      ...e,
                      resources: {
                        ...e.resources,
                        [node.config.resource]: {
                          ...resource,
                          versionBehavior: event.target.value as
                            "pinned" | "latest-published",
                        },
                      },
                    },
                  });
              }}
            >
              <option value="pinned">Pinned published version</option>
              <option value="latest-published">
                Latest published when this step starts
              </option>
            </select>
          </label>
          <p>
            Uses the same durable workflow engine. Waits for the child result.
            Recursive workflow calls are blocked.
          </p>
          {node.kind === "subworkflow" && (
            <label>
              Result field (JSON Pointer; blank keeps the full result)
              <input
                value={node.config.outputPath}
                placeholder="/invoiceNumber"
                onChange={(event) =>
                  change({ ...node.config, outputPath: event.target.value })
                }
              />
            </label>
          )}
          {node.kind === "for-each" && (
            <>
              <h4>Collection</h4>
              <FieldPicker
                referenceOnly
                definition={definition}
                nodeId={node.id}
                value={node.config.collection}
                onChange={(collection) => {
                  if (collection.type === "reference")
                    change({ ...node.config, collection });
                }}
              />
              <label>
                Skip first items
                <input
                  type="number"
                  min="0"
                  max="99"
                  value={node.config.startIndex}
                  onChange={(event) =>
                    change({
                      ...node.config,
                      startIndex: Number(event.target.value),
                    })
                  }
                />
              </label>
              <label>
                Maximum items
                <input
                  type="number"
                  min="1"
                  max="100"
                  value={node.config.maxItems}
                  onChange={(event) =>
                    change({
                      ...node.config,
                      maxItems: Number(event.target.value),
                    })
                  }
                />
              </label>
              <label>
                Item failure
                <select
                  value={node.config.failurePolicy}
                  onChange={(event) =>
                    change({
                      ...node.config,
                      failurePolicy: event.target.value as
                        "continue" | "fail-workflow",
                    })
                  }
                >
                  <option value="fail-workflow">Fail the workflow</option>
                  <option value="continue">
                    Continue and record failed item
                  </option>
                </select>
              </label>
              <h4>Body input fields</h4>
              <Mappings
                fields={node.config.itemInputs}
                definition={definition}
                nodeId={node.id}
                onChange={(itemInputs) =>
                  change({ ...node.config, itemInputs })
                }
              />
              <p>
                Leave fields empty to pass the item as input. The body can also
                use Current item and Iteration → index. Items run sequentially,
                with a maximum of 100 descendant runs per root workflow.
              </p>
            </>
          )}
        </>
      )}
      {node.kind === "wait" && (
        <>
          <label>
            Wait mode
            <select
              value={node.config.mode}
              onChange={(event) =>
                change({
                  ...node.config,
                  mode: event.target.value as "duration" | "until",
                  until: node.config.until ?? {
                    type: "literal",
                    value: new Date().toISOString(),
                  },
                })
              }
            >
              <option value="duration">Wait for a duration</option>
              <option value="until">Wait until a timestamp</option>
            </select>
          </label>
          {node.config.mode === "duration" ? (
            <>
              <label>
                Duration
                <input
                  type="number"
                  min="1"
                  max={2592000 / waitUnit}
                  value={node.config.seconds / waitUnit}
                  onChange={(event) =>
                    change({
                      ...node.config,
                      seconds: Math.round(
                        Number(event.target.value) * waitUnit,
                      ),
                    })
                  }
                />
              </label>
              <label>
                Time unit
                <select
                  value={waitUnit}
                  onChange={(event) => {
                    const unit = Number(event.target.value);
                    change({
                      ...node.config,
                      seconds: Math.min(
                        2592000,
                        Math.max(
                          1,
                          Math.round((node.config.seconds / waitUnit) * unit),
                        ),
                      ),
                    });
                    setWaitUnit(unit);
                  }}
                >
                  <option value="1">Seconds</option>
                  <option value="60">Minutes</option>
                  <option value="3600">Hours</option>
                </select>
              </label>
            </>
          ) : (
            picker(
              node.config.until ?? { type: "literal", value: "" },
              (until) => change({ ...node.config, until }),
            )
          )}
          <p>
            The worker is released while waiting. Maximum wait: 30 days.
            Timestamps must include a timezone.
          </p>
        </>
      )}
      {node.kind === "wait-for-event" && (
        <>
          <label>
            Event name
            <input
              value={node.config.eventName}
              onChange={(event) =>
                change({ ...node.config, eventName: event.target.value })
              }
            />
          </label>
          <label>
            Timeout (seconds)
            <input
              type="number"
              min="1"
              max="2592000"
              value={node.config.timeoutSeconds}
              onChange={(event) =>
                change({
                  ...node.config,
                  timeoutSeconds: Number(event.target.value),
                })
              }
            />
          </label>
          <h4>Event data schema</h4>
          <SchemaEditor
            value={node.config.outputSchema as ValueSchema}
            onChange={(outputSchema) =>
              change({ ...node.config, outputSchema: outputSchema as never })
            }
          />
          <p>
            When the run pauses, an authorized operator can issue a scoped
            callback token from Test / runs. Tokens expire and can be rotated.
          </p>
        </>
      )}
      {![
        "input",
        "output",
        "parallel",
        "merge",
        "condition",
        "switch",
        "approval",
        "human-task",
      ].includes(node.kind) && (
        <details>
          <summary>Failure recovery / error route</summary>
          <label>
            On error
            <select
              value={node.onError ?? ""}
              onChange={(event) =>
                onChange({
                  ...definition,
                  execution: {
                    ...e,
                    nodes: e.nodes.map((n) =>
                      n.id === node.id
                        ? { ...n, onError: event.target.value || undefined }
                        : n,
                    ),
                  },
                })
              }
            >
              <option value="">Fail this workflow</option>
              {e.nodes
                .filter((n) => n.id !== node.id && n.kind !== "input")
                .map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.label}
                  </option>
                ))}
            </select>
          </label>
          <p>
            Error handlers can map Error → code, message, nodeId and attempt.
            Messages are sanitized.
          </p>
        </details>
      )}
      {node.kind === "condition" && (
        <>
          <h4>Left value</h4>
          {picker(node.config.condition.left, (left) =>
            change({
              ...node.config,
              condition: { ...node.config.condition, left },
            }),
          )}
          <label>
            Operator
            <select
              value={node.config.condition.operator}
              onChange={(event) => {
                const operator = event.target
                  .value as typeof node.config.condition.operator;
                change({
                  ...node.config,
                  condition: {
                    ...node.config.condition,
                    operator,
                    ...(["empty", "not-empty", "true", "false"].includes(
                      operator,
                    )
                      ? { right: undefined }
                      : {
                          right: node.config.condition.right ?? {
                            type: "literal",
                            value: "",
                          },
                        }),
                  },
                });
              }}
            >
              {workflowCondition.shape.operator.options.map((op) => (
                <option key={op} value={op}>
                  {op.replaceAll("-", " ")}
                </option>
              ))}
            </select>
          </label>
          {!["empty", "not-empty", "true", "false"].includes(
            node.config.condition.operator,
          ) && (
            <>
              <h4>Right value</h4>
              {picker(
                node.config.condition.right ?? { type: "literal", value: "" },
                (right) =>
                  change({
                    ...node.config,
                    condition: { ...node.config.condition, right },
                  }),
              )}
            </>
          )}
        </>
      )}
      {node.kind === "switch" && (
        <>
          <h4>Route on value</h4>
          {picker(node.config.value, (value) =>
            change({ ...node.config, value }),
          )}
          {node.config.cases.map((c, i) => (
            <fieldset key={c.id}>
              <legend>
                Case {i + 1} · {c.id}
              </legend>
              <label>
                Label
                <input
                  value={c.label}
                  onChange={(event) =>
                    change({
                      ...node.config,
                      cases: node.config.cases.map((old) =>
                        old.id === c.id
                          ? { ...c, label: event.target.value }
                          : old,
                      ),
                    })
                  }
                />
              </label>
              {picker({ type: "literal", value: c.value }, (value) => {
                if (value.type === "literal")
                  change({
                    ...node.config,
                    cases: node.config.cases.map((old) =>
                      old.id === c.id ? { ...c, value: value.value } : old,
                    ),
                  });
              })}
              <Button
                onClick={() =>
                  change({
                    ...node.config,
                    cases: node.config.cases.filter((old) => old.id !== c.id),
                  })
                }
              >
                Remove case
              </Button>
            </fieldset>
          ))}
          <Button
            disabled={node.config.cases.length >= 10}
            onClick={() =>
              change({
                ...node.config,
                cases: [
                  ...node.config.cases,
                  {
                    id: "case_" + crypto.randomUUID().slice(0, 8),
                    label: "New route",
                    value: "",
                  },
                ],
              })
            }
          >
            + Case
          </Button>
          <p>Connect every case and the default handle to its route.</p>
        </>
      )}
      {!["input", "transform", "set-variable", "for-each"].includes(
        node.kind,
      ) && (
        <details open>
          <summary>
            {node.kind === "output" ? "Workflow result" : "Input mapping"}
          </summary>
          {input ? (
            picker(input, (next) =>
              change({ ...node.config, input: next } as V2Node["config"]),
            )
          ) : (
            <p>Receives the previous step’s output.</p>
          )}
          <Button
            onClick={() =>
              change({
                ...node.config,
                input: input ? undefined : ref("input"),
              } as V2Node["config"])
            }
          >
            {input ? "Use previous output" : "Choose mapped value"}
          </Button>
        </details>
      )}
    </div>
  );
}
