"use client";
import { useId, useState } from "react";
import { Button } from "./button";
export function resourceHref(
  workspaceId: string,
  kind: "knowledge" | "tools",
  id?: string,
) {
  const params = new URLSearchParams(window.location.hash.slice(1));
  params.set("workspace", workspaceId);
  params.set("view", kind === "tools" ? "Tools" : "Knowledge");
  params.delete("agent");
  params.delete("tool");
  params.delete("knowledgeBase");
  params.delete("createResource");
  if (kind === "tools") {
    params.set("toolsSection", "configure");
    if (id) params.set("tool", id);
  } else {
    params.set("knowledgeSection", "bases");
    if (id) params.set("knowledgeBase", id);
  }
  if (!id) params.set("createResource", kind);
  return `/#${params}`;
}
export function WorkflowResourcePicker({
  workspaceId,
  kind,
  items,
  selected,
  loading,
  error,
  onRetry,
  onChange,
}: {
  workspaceId: string;
  kind: "knowledge" | "tools";
  items: { id: string; name: string; enabled?: boolean }[];
  selected: string[];
  loading: boolean;
  error: Error | null;
  onRetry: () => void;
  onChange: (ids: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [choice, setChoice] = useState("");
  const listId = useId();
  const title = kind === "knowledge" ? "Knowledge bases" : "Tools";
  const singular = kind === "knowledge" ? "knowledge base" : "tool";
  const max = kind === "knowledge" ? 5 : 8;
  const available = items.filter(
    (i) => i.enabled !== false && !selected.includes(i.id),
  );
  const filtered = available.filter((i) =>
    i.name.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <section className="workflow-resource-picker" aria-label={title}>
      <div className="workflow-resource-heading">
        <strong>
          {title} · {selected.length}/{max}
        </strong>
        <Button
          type="button"
          className="secondary"
          aria-expanded={open}
          aria-controls={listId}
          disabled={loading || selected.length >= max}
          onClick={() => {
            setOpen(!open);
            setSearch("");
            setChoice("");
          }}
        >
          ＋ Add {singular}
        </Button>
      </div>
      <p className="muted">
        Attach multiple {kind === "knowledge" ? "knowledge bases" : "tools"} (up
        to {max}).
      </p>
      {loading ? (
        <p role="status">Loading {title.toLowerCase()}…</p>
      ) : error ? (
        <div role="alert">
          <p>Could not load {title.toLowerCase()}.</p>
          <Button type="button" className="secondary" onClick={onRetry}>
            Retry {title.toLowerCase()}
          </Button>
        </div>
      ) : (
        <>
          {!items.some((i) => i.enabled !== false) && (
            <p>
              No {kind === "knowledge" ? "knowledge bases" : "enabled tools"}{" "}
              available.{" "}
              <a
                href={resourceHref(workspaceId, kind)}
                target="_blank"
                rel="noopener noreferrer"
              >
                Create {singular} ↗
              </a>
            </p>
          )}
          {open && (
            <div
              id={listId}
              className="workflow-resource-search"
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setOpen(false);
                  e.stopPropagation();
                }
              }}
            >
              <label>
                Search {title.toLowerCase()}
                <input
                  type="search"
                  aria-label={`Search ${title.toLowerCase()}`}
                  placeholder="Search by keyword…"
                  value={search}
                  onChange={(e) => {
                    setSearch(e.target.value);
                    setChoice("");
                  }}
                />
              </label>
              <label>
                Select {singular}
                <select
                  aria-label={`Select ${singular}`}
                  value={choice}
                  onChange={(e) => setChoice(e.target.value)}
                >
                  <option value="">Choose {singular}</option>
                  {filtered.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.name}
                    </option>
                  ))}
                </select>
              </label>
              {!filtered.length && (
                <p>
                  {available.length
                    ? "No matching results."
                    : "No more items to add."}
                </p>
              )}
              <Button
                type="button"
                disabled={!choice || selected.length >= max}
                onClick={() => {
                  if (available.some((i) => i.id === choice)) {
                    onChange([...selected, choice]);
                    setChoice("");
                    setSearch("");
                  }
                }}
              >
                Add selected {singular}
              </Button>
              <a
                href={resourceHref(workspaceId, kind)}
                target="_blank"
                rel="noopener noreferrer"
              >
                Create {singular} ↗
              </a>
            </div>
          )}
        </>
      )}
      {selected.length ? (
        <ul className="workflow-resource-list">
          {selected.map((id) => {
            const item = items.find((i) => i.id === id);
            return (
              <li key={id}>
                <span>
                  {item?.name ?? `Unavailable ${singular}`}
                  {item?.enabled === false ? " (disabled)" : ""}
                </span>
                <div>
                  <a
                    href={resourceHref(workspaceId, kind, id)}
                    aria-label={`Configure ${item?.name ?? singular}`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Configure ↗
                  </a>
                  <Button
                    type="button"
                    className="text-button"
                    aria-label={`Remove ${item?.name ?? singular}`}
                    onClick={() => onChange(selected.filter((i) => i !== id))}
                  >
                    Remove
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="muted">No {title.toLowerCase()} attached.</p>
      )}
    </section>
  );
}
