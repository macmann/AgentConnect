"use client";
import { useQuery } from "@tanstack/react-query";
import { requestJson } from "./agent-client";
export function AgentKnowledgeRelease({
  baseId,
  name,
  value,
  onChange,
}: {
  baseId: string;
  name: string;
  value?: string;
  onChange: (v: string) => void;
}) {
  const releases = useQuery({
    queryKey: ["knowledge-releases", baseId],
    queryFn: () =>
      requestJson<
        { id: string; version: number; name: string; status: string }[]
      >(`/knowledge-bases/${baseId}/releases`),
  });
  return (
    <label>
      {name} — knowledge release
      <select
        aria-label={`${name} — knowledge release`}
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">Follow current published release</option>
        {releases.data
          ?.filter((r) => r.status === "published")
          .map((r) => (
            <option key={r.id} value={r.id}>
              Version {r.version} · {r.name}
            </option>
          ))}
        {value && !releases.data?.some((r) => r.id === value) && (
          <option value={value}>Pinned release unavailable</option>
        )}
      </select>
      {releases.error && <span role="alert">{releases.error.message}</span>}
      {releases.data &&
        !releases.data.some((r) => r.status === "published") && (
          <small>
            No published release. Ask an administrator to review and publish
            knowledge.
          </small>
        )}
    </label>
  );
}
