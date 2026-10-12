"use client";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { requestJson } from "./agent-client";
import { BookOpen, Wrench, ArrowUpRight, Plus } from "lucide-react";
import { Button } from "./button";

type Attachment = {
  id: string;
  name: string;
  public_access: boolean;
  enabled?: boolean;
  source_count?: number;
  ready_count?: number;
  failed_count?: number;
  indexing_count?: number;
  kind?: string;
  type?: string;
};
export function AgentAttachments({
  kind,
  items,
  selected,
  loading,
  error,
  onRetry,
  onNavigate,
  onToggle,
  canManage,
}: {
  kind: "knowledge" | "tools";
  items: Attachment[];
  selected: string[];
  loading: boolean;
  error: Error | null;
  onRetry: () => void;
  onNavigate: () => void;
  onToggle: (id: string, checked: boolean) => void;
  canManage: boolean;
}) {
  const cache = useQueryClient();
  const [enabling, setEnabling] = useState<string | null>(null);
  const [enableError, setEnableError] = useState("");
  const [notice, setNotice] = useState("");
  async function enableTool(id: string) {
    if (!canManage || kind !== "tools" || enabling) return;
    setEnabling(id);
    setEnableError("");
    setNotice("");
    try {
      const tool = await requestJson<{
        name: string;
        description: string;
        config: unknown;
        public_access: boolean;
        timeout_ms: number;
        revision: number;
      }>(`/tools/${id}`);
      await requestJson(`/tools/${id}`, "PUT", {
        name: tool.name,
        description: tool.description,
        config: tool.config,
        publicAccess: tool.public_access,
        timeoutMs: tool.timeout_ms,
        revision: tool.revision,
        enabled: true,
        readOnlyAcknowledged: true,
      });
      await cache.invalidateQueries({ queryKey: ["tools"] });
      setNotice(
        "Tool enabled for this workspace. Select it to attach, then save your agent.",
      );
    } catch (error) {
      setEnableError(
        error instanceof Error
          ? error.message
          : "Could not enable this tool. Try again.",
      );
    } finally {
      setEnabling(null);
    }
  }
  const knowledge = kind === "knowledge";
  const Icon = knowledge ? BookOpen : Wrench;
  const title = knowledge ? "Attached knowledge" : "Attached tools";
  const unavailable = selected.filter(
    (id) => !items.some((item) => item.id === id),
  );
  return (
    <section className="agent-attachments" aria-label={title}>
      <div className="attachment-header">
        <div className="attachment-heading">
          <span className="attachment-icon">
            <Icon size={20} aria-hidden="true" />
          </span>
          <div>
            <h4>{title}</h4>
            <p>
              {knowledge
                ? "Ground answers in your workspace’s documents and sources."
                : "Let your agent use approved read-only tools."}
            </p>
          </div>
        </div>
        <button
          type="button"
          className="text-button attachment-link"
          onClick={onNavigate}
        >
          {knowledge ? "Manage knowledge" : "Manage tools"}
          <ArrowUpRight size={15} aria-hidden="true" />
        </button>
      </div>
      {enableError && (
        <p className="attachment-status error" role="alert">
          {enableError}
        </p>
      )}
      {notice && (
        <p className="attachment-status" role="status">
          {notice}
        </p>
      )}
      {loading ? (
        <p className="attachment-status" role="status">
          Loading {knowledge ? "knowledge bases" : "tools"}…
        </p>
      ) : error ? (
        <div className="attachment-status" role="alert">
          <strong>
            Could not load {knowledge ? "knowledge bases" : "tools"}.
          </strong>
          <p>{error.message}</p>
          <Button type="button" onClick={onRetry}>
            Try again
          </Button>
        </div>
      ) : (
        <>
          {items.length ? (
            <>
              <p className="attachment-count">
                {
                  selected.filter((id) => items.some((item) => item.id === id))
                    .length
                }{" "}
                selected · Select items to attach, then save your agent.
              </p>
              <div className="attachment-options">
                {items.map((item) => (
                  <div
                    key={item.id}
                    className={`attachment-option${selected.includes(item.id) ? " is-selected" : ""}`}
                  >
                    <label className="attachment-selection">
                      <input
                        type="checkbox"
                        aria-describedby={
                          item.enabled === false
                            ? `${kind}-${item.id}-help`
                            : undefined
                        }
                        aria-label={`${item.name} · ${item.public_access ? "Public chat enabled" : "Workspace only"}`}
                        checked={selected.includes(item.id)}
                        disabled={
                          !selected.includes(item.id) &&
                          (item.enabled === false ||
                            selected.length >= (knowledge ? 5 : 8))
                        }
                        onChange={(e) => onToggle(item.id, e.target.checked)}
                      />
                      <span className="attachment-option-name">
                        {item.name}
                        <small className="attachment-health">
                          {knowledge
                            ? `${item.ready_count ?? 0} / ${item.source_count ?? 0} sources ready${item.failed_count ? ` · ${item.failed_count} failed` : ""}${item.indexing_count ? ` · ${item.indexing_count} indexing` : ""}`
                            : `${item.enabled === false ? "Disabled" : "Enabled"}${item.kind || item.type ? ` · ${item.kind ?? item.type}` : ""}`}
                        </small>
                      </span>
                      <span
                        className={`attachment-access${item.public_access ? " is-public" : ""}`}
                      >
                        {item.public_access
                          ? "Public chat enabled"
                          : "Workspace only"}
                      </span>
                    </label>
                    {!knowledge && item.enabled === false && canManage && (
                      <Button
                        type="button"
                        disabled={!!enabling}
                        aria-label={`Enable ${item.name}`}
                        onClick={() => void enableTool(item.id)}
                      >
                        {enabling === item.id ? "Enabling…" : "Enable tool"}
                      </Button>
                    )}
                    {item.enabled === false && (
                      <small
                        id={`${kind}-${item.id}-help`}
                        className="attachment-disabled-help"
                      >
                        {canManage
                          ? "Disabled in this workspace. Enable the tool before attaching it. Enabling applies across the workspace."
                          : "Disabled in this workspace. Ask a workspace administrator to enable this tool before attaching it."}
                      </small>
                    )}
                  </div>
                ))}
              </div>
              <p className="attachment-footnote">
                {knowledge
                  ? "Only ready sources are used when answering."
                  : "Tool definitions follow current workspace settings."}{" "}
                Public chat requires public access on every attachment.
              </p>
            </>
          ) : (
            <div className="attachment-empty">
              <Icon size={28} aria-hidden="true" />
              <h5>
                {knowledge
                  ? "No knowledge bases in this workspace"
                  : "No enabled tools in this workspace"}
              </h5>
              <p>
                {knowledge
                  ? "Create a knowledge base and add documents or Q&A, then return here to attach it."
                  : canManage
                    ? "Register or enable a tool, then return here to attach it."
                    : "Ask a workspace administrator to register or enable a tool. You can view the tool registry now."}
              </p>
              <Button type="button" onClick={onNavigate}>
                <Plus size={16} aria-hidden="true" />
                {knowledge
                  ? "Create knowledge base"
                  : canManage
                    ? "Register or enable tools"
                    : "View tools"}
              </Button>
            </div>
          )}
          {!!unavailable.length && (
            <div className="attachment-status" role="alert">
              <p>
                {unavailable.length} saved attachment(s) are unavailable or
                disabled. Remove them or check workspace settings.
              </p>
              {unavailable.map((id, index) => (
                <button
                  key={id}
                  type="button"
                  className="text-button"
                  onClick={() => onToggle(id, false)}
                >
                  Remove unavailable attachment {index + 1}
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}
