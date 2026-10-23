"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { requestJson, apiBase } from "./agent-client";
import { Button } from "./button";
import { HelpTooltip } from "./help-tooltip";
export function PlatformKeyForm({
  workspaceId,
  agents,
  busy,
  onCreate,
}: {
  workspaceId: string;
  agents: { id: string; name: string }[];
  busy: boolean;
  onCreate: (data: {
    label: string;
    agentId?: string;
    knowledgeBaseId?: string;
    detailsEnabled: boolean;
    scope: "agent:invoke" | "knowledge:search";
    expiresInDays: number;
  }) => void;
}) {
  const [resourceType, setResourceType] = useState("agent");
  const bases = useQuery({
    queryKey: ["platform-key-bases", workspaceId],
    queryFn: () =>
      requestJson<{ id: string; name: string }[]>(
        `/workspaces/${workspaceId}/knowledge-bases`,
      ),
    enabled: resourceType === "knowledge",
  });
  const resources = resourceType === "agent" ? agents : (bases.data ?? []);
  return (
    <>
      <h4>Platform API & MCP keys</h4>
      <p className="muted">
        Connect an application to one agent or knowledge base.
      </p>
      <form
        className="form-grid platform-key-form"
        onSubmit={(e) => {
          e.preventDefault();
          const data = new FormData(e.currentTarget);
          onCreate({
            label: String(data.get("label")),
            ...(resourceType === "agent"
              ? { agentId: String(data.get("resource")) }
              : { knowledgeBaseId: String(data.get("resource")) }),
            detailsEnabled: data.get("details") === "on",
            scope:
              resourceType === "agent" ? "agent:invoke" : "knowledge:search",
            expiresInDays: Number(data.get("days")),
          });
        }}
      >
        <label>
          Key label
          <input name="label" required maxLength={100} />
        </label>
        <label>
          Resource type
          <select
            value={resourceType}
            onChange={(e) => setResourceType(e.target.value)}
          >
            <option value="agent">Agent invocation</option>
            <option value="knowledge">Knowledge search</option>
          </select>
        </label>
        <label>
          {resourceType === "agent" ? "Agent" : "Knowledge base"}
          <select
            name="resource"
            aria-label={resourceType === "agent" ? "Agent" : "Knowledge base"}
            required
            key={resourceType}
          >
            <option value="">
              Select{" "}
              {resourceType === "agent" ? "an agent" : "a knowledge base"}
            </option>
            {resources.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Expires in days
          <input
            name="days"
            type="number"
            min={1}
            max={365}
            defaultValue={30}
            required
          />
        </label>
        <div className="checkbox-row">
          <label className="checkbox-label">
            <input type="checkbox" name="details" />
            Allow execution details
          </label>
          <HelpTooltip label="About execution details">
            Allows callers to request tool inputs/outputs, retrieved chunks and
            ranking stages. This can expose private workspace content. Basic
            agent calls return answers and citations. Knowledge search always
            returns raw matches. Keys inherit the issuer’s current permissions
            and can be revoked.
          </HelpTooltip>
        </div>
        {bases.error && resourceType === "knowledge" && (
          <p className="error-text">{bases.error.message}</p>
        )}
        {!resources.length && !bases.isLoading && (
          <p className="muted">
            Create {resourceType === "agent" ? "an agent" : "a knowledge base"}{" "}
            before issuing a key.
          </p>
        )}
        <Button disabled={busy || !resources.length}>Create API key</Button>
      </form>
      <details className="advanced-settings">
        <summary>Connection endpoints</summary>
        <p>
          Send the key as an Authorization Bearer header. Keep keys on your
          server.
        </p>
        <p>
          REST: <code>{apiBase}/api/v1/resources</code>
        </p>
        <p>
          MCP (Streamable HTTP): <code>{apiBase}/mcp</code>
        </p>
        <p>
          Agents use published versions; publish a version before calling.
          Conversation IDs are bound to the issuing key. Add{" "}
          <code>includeDetails: true</code> to requests when the key allows
          details. Existing streaming chat integrations continue to work.
        </p>
      </details>
    </>
  );
}
