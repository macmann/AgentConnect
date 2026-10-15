"use client";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  extractComponent,
  insertComponent,
} from "@agentconnect/schemas/workflow-components";
import type { WorkflowGraph } from "@agentconnect/schemas/workflows";
import { requestJson } from "./agent-client";
import { HelpTooltip } from "./help-tooltip";
import { Button } from "./button";
type Component = {
  id: string;
  name: string;
  description: string;
  revision: number;
  graph: WorkflowGraph;
};
export function WorkflowComponentLibrary({
  workspaceId,
  graph,
  selection,
  anchor,
  disabled,
  onInsert,
}: {
  workspaceId: string;
  graph: WorkflowGraph;
  selection: string[];
  anchor: string;
  disabled: boolean;
  onInsert: (graph: WorkflowGraph) => void;
}) {
  const cache = useQueryClient(),
    [chosen, setChosen] = useState(""),
    [version, setVersion] = useState(""),
    [name, setName] = useState(""),
    [description, setDescription] = useState(""),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [error, setError] = useState("");
  const components = useQuery({
    queryKey: ["workflow-components", workspaceId],
    queryFn: () =>
      requestJson<Component[]>(
        `/workspaces/${workspaceId}/workflow-components`,
      ),
  });
  const selected = components.data?.find((c) => c.id === chosen);
  const versions = useQuery({
    queryKey: ["workflow-component-versions", chosen, selected?.revision],
    queryFn: () =>
      requestJson<{ version: number; graph: WorkflowGraph }[]>(
        `/workflow-components/${chosen}/versions`,
      ),
    enabled: !!chosen,
  });
  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <details className="configure-group workflow-component-library">
      <summary>
        Reusable components{" "}
        <HelpTooltip label="About reusable workflow components">
          Save a selected group with one entry and exit. Inserted nodes are
          independent copies pinned to the selected library version; later
          library updates never change saved workflows. Normal draft save,
          validation and publication still apply.
        </HelpTooltip>
      </summary>
      {(error || components.error || versions.error) && (
        <p role="alert">
          {error || components.error?.message || versions.error?.message}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      <div className="workflow-component-fields">
        <label>
          Library component
          <select
            value={chosen}
            disabled={busy || disabled}
            onChange={(e) => {
              const c = components.data?.find((c) => c.id === e.target.value);
              setChosen(e.target.value);
              setVersion("");
              setName(c?.name ?? "");
              setDescription(c?.description ?? "");
              setMessage("");
              setError("");
            }}
          >
            <option value="">New component</option>
            {components.data?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} · v{c.revision}
              </option>
            ))}
          </select>
        </label>
        {selected && (
          <label>
            Component version
            <select
              value={version}
              disabled={busy || disabled}
              onChange={(e) => setVersion(e.target.value)}
            >
              <option value="">Latest · v{selected.revision}</option>
              {versions.data
                ?.filter((v) => v.version !== selected.revision)
                .map((v) => (
                  <option key={v.version} value={v.version}>
                    v{v.version}
                  </option>
                ))}
            </select>
          </label>
        )}
        <label>
          Component name
          <input
            value={name}
            maxLength={100}
            disabled={busy || disabled}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label>
          Description
          <input
            value={description}
            maxLength={2000}
            disabled={busy || disabled}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
      </div>
      <div className="workflow-picker">
        <Button
          disabled={busy || disabled || !name.trim() || !selection.length}
          onClick={() =>
            void act(async () => {
              const body = {
                name,
                description,
                graph: extractComponent(graph, selection),
                ...(selected ? { revision: selected.revision } : {}),
              };
              const result = await requestJson<{
                id: string;
                revision: number;
              }>(
                selected
                  ? `/workflow-components/${selected.id}/versions`
                  : `/workspaces/${workspaceId}/workflow-components`,
                "POST",
                body,
              );
              await cache.invalidateQueries({
                queryKey: ["workflow-components", workspaceId],
              });
              setChosen(result.id);
              setVersion("");
              setMessage(
                `Component v${result.revision} saved. Existing workflows are unchanged.`,
              );
            })
          }
        >
          {selected
            ? "Save selection as new version"
            : "Save selection as component"}
        </Button>
        <Button
          className="secondary"
          disabled={busy || disabled || !selected}
          onClick={() =>
            void act(async () => {
              const component = version
                ? versions.data?.find((v) => v.version === Number(version))
                    ?.graph
                : selected?.graph;
              if (!component)
                throw new Error(
                  "The selected version is unavailable; reload the library",
                );
              const next = insertComponent(
                graph,
                component,
                anchor,
                "c" + crypto.randomUUID().replaceAll("-", "").slice(0, 12),
              );
              onInsert(next);
              setMessage(
                "Component inserted. Review and save the workflow draft.",
              );
            })
          }
        >
          Insert after selected node
        </Button>
        {selected && (
          <Button
            className="ghost"
            disabled={busy || disabled}
            onClick={() =>
              void act(async () => {
                if (
                  !window.confirm(
                    "Archive this library component? Existing workflows keep their nodes.",
                  )
                )
                  return;
                await requestJson(
                  `/workflow-components/${selected.id}`,
                  "DELETE",
                );
                setChosen("");
                setName("");
                setDescription("");
                await cache.invalidateQueries({
                  queryKey: ["workflow-components", workspaceId],
                });
                setMessage(
                  "Component archived. Existing workflows are unchanged.",
                );
              })
            }
          >
            Archive component
          </Button>
        )}
      </div>
      <p className="muted">
        {selection.length} nodes selected · Select processing nodes on the
        canvas, excluding Input and Output.
      </p>
    </details>
  );
}
