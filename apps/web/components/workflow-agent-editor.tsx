"use client";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { agentConfig, type AgentConfig } from "@agentconnect/schemas/agents";
import { requestJson } from "./agent-client";
import { CreationAssistant } from "./creation-assistant";
import { Button } from "./button";

export function WorkflowAgentEditor({
  workspaceId,
  name,
  config,
  onChange,
  onSettings,
}: {
  workspaceId: string;
  name: string;
  config?: AgentConfig;
  onChange: (config: AgentConfig) => void;
  onSettings: () => void;
}) {
  const cache = useQueryClient();
  const [ai, setAi] = useState(false);
  const [status, setStatus] = useState("");
  const [saving, setSaving] = useState(false);
  const [shared, setShared] = useState(false);
  const models = useQuery({
    queryKey: ["models", workspaceId],
    queryFn: () =>
      requestJson<{ id: string; name: string }[]>(
        `/workspaces/${workspaceId}/models`,
      ),
  });
  const knowledge = useQuery({
    queryKey: ["workflow-knowledge", workspaceId],
    queryFn: () =>
      requestJson<{ id: string; name: string }[]>(
        `/workspaces/${workspaceId}/knowledge-bases`,
      ),
  });
  const tools = useQuery({
    queryKey: ["workflow-tools", workspaceId],
    queryFn: () =>
      requestJson<{ id: string; name: string; enabled: boolean }[]>(
        `/workspaces/${workspaceId}/tools`,
      ),
  });
  if (ai)
    return (
      <CreationAssistant
        workspaceId={workspaceId}
        kind="agent"
        onSettings={onSettings}
        onManual={() => setAi(false)}
        onCancel={() => setAi(false)}
        onAgent={(p) => {
          onChange(p.config);
          setAi(false);
        }}
      />
    );
  return (
    <section
      className="workflow-agent-editor"
      aria-label="Workflow agent setup"
    >
      <p>
        Create an agent owned by this workflow. Configure it yourself or
        describe its task to AI.
      </p>
      <Button className="secondary" onClick={() => setAi(true)}>
        AI mode · describe the task
      </Button>
      {!config ? (
        <label>
          Runtime model
          <select
            aria-label="Runtime model"
            value=""
            onChange={(e) => {
              if (e.target.value)
                onChange(
                  agentConfig.parse({
                    modelId: e.target.value,
                    rag: {},
                    tools: {},
                  }),
                );
            }}
          >
            <option value="">Choose a model to start</option>
            {models.data?.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <>
          <label>
            Runtime model
            <select
              aria-label="Runtime model"
              value={config.modelId}
              onChange={(e) => onChange({ ...config, modelId: e.target.value })}
            >
              {models.data?.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Agent task prompt
            <textarea
              aria-label="Agent task prompt"
              rows={5}
              maxLength={12000}
              value={config.prompt.instructions}
              onChange={(e) =>
                onChange({
                  ...config,
                  prompt: { ...config.prompt, instructions: e.target.value },
                })
              }
            />
          </label>
          <label>
            Role
            <input
              value={config.prompt.role}
              maxLength={4000}
              onChange={(e) =>
                onChange({
                  ...config,
                  prompt: { ...config.prompt, role: e.target.value },
                })
              }
            />
          </label>
          <label>
            Temperature
            <input
              type="number"
              min={0}
              max={1}
              step={0.1}
              value={config.temperature}
              onChange={(e) =>
                onChange({ ...config, temperature: Number(e.target.value) })
              }
            />
          </label>
          <label>
            Maximum output tokens
            <input
              type="number"
              min={1}
              max={2000000}
              value={config.maxOutputTokens}
              onChange={(e) =>
                onChange({ ...config, maxOutputTokens: Number(e.target.value) })
              }
            />
          </label>
          <details>
            <summary>
              Knowledge · {config.rag.knowledgeBaseIds.length} attached
            </summary>
            {knowledge.data?.map((k) => (
              <label key={k.id}>
                <input
                  type="checkbox"
                  checked={config.rag.knowledgeBaseIds.includes(k.id)}
                  onChange={(e) =>
                    onChange({
                      ...config,
                      rag: {
                        ...config.rag,
                        knowledgeBaseIds: e.target.checked
                          ? [...config.rag.knowledgeBaseIds, k.id]
                          : config.rag.knowledgeBaseIds.filter(
                              (id) => id !== k.id,
                            ),
                      },
                    })
                  }
                />
                {k.name}
              </label>
            ))}
          </details>
          <details>
            <summary>Tools · {config.tools.toolIds.length} attached</summary>
            {tools.data
              ?.filter((t) => t.enabled)
              .map((t) => (
                <label key={t.id}>
                  <input
                    type="checkbox"
                    checked={config.tools.toolIds.includes(t.id)}
                    onChange={(e) =>
                      onChange({
                        ...config,
                        tools: {
                          ...config.tools,
                          toolIds: e.target.checked
                            ? [...config.tools.toolIds, t.id]
                            : config.tools.toolIds.filter((id) => id !== t.id),
                        },
                      })
                    }
                  />
                  {t.name}
                </label>
              ))}
          </details>
          <label>
            <input
              type="checkbox"
              checked={shared}
              onChange={(e) => setShared(e.target.checked)}
            />
            Also make a reusable copy in Agents
          </label>
          {shared && (
            <Button
              className="secondary"
              disabled={saving}
              onClick={async () => {
                setSaving(true);
                setStatus("");
                try {
                  await requestJson(
                    `/workspaces/${workspaceId}/agents`,
                    "POST",
                    {
                      name,
                      description: "Created in workflow canvas",
                      publicDescription: "",
                      config,
                    },
                  );
                  await cache.invalidateQueries({
                    queryKey: ["agents", workspaceId],
                  });
                  setStatus(
                    "Saved a reusable draft in Agents. This workflow keeps its own configuration.",
                  );
                  setShared(false);
                } catch (e) {
                  setStatus((e as Error).message);
                } finally {
                  setSaving(false);
                }
              }}
            >
              Save copy to Agents
            </Button>
          )}
          {status && <p role="status">{status}</p>}
        </>
      )}
      {(models.error || knowledge.error || tools.error) && (
        <p role="alert">
          Some resources could not be loaded.{" "}
          {String((models.error || knowledge.error || tools.error)?.message)}
        </p>
      )}
    </section>
  );
}
