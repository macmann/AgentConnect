"use client";
import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiBase, requestJson } from "./agent-client";
import { Button } from "./button";
import { HelpTooltip } from "./help-tooltip";
import { ChatMarkdown } from "./chat-markdown";
export type SkillSummary = {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  public_access: boolean;
  revision: number;
  version_id: string;
  version: number;
  warnings: string[];
  versions: { id: string; version: number; name: string }[];
};
type Detail = Omit<SkillSummary, "versions"> & {
  versions: {
    id: string;
    version: number;
    name: string;
    description: string;
    instructions: string;
    reference_files: { path: string; content: string }[];
    ignored_files: string[];
    warnings: string[];
  }[];
};
export function SkillsStudio({
  workspaceId,
  role,
}: {
  workspaceId: string;
  role: string;
}) {
  const cache = useQueryClient(),
    input = useRef<HTMLInputElement>(null);
  const list = useQuery({
    queryKey: ["agent-skills", workspaceId],
    queryFn: () =>
      requestJson<SkillSummary[]>(`/workspaces/${workspaceId}/agent-skills`),
  });
  const [selected, setSelected] = useState("");
  const detail = useQuery({
    queryKey: ["agent-skill", selected],
    queryFn: () => requestJson<Detail>(`/agent-skills/${selected}`),
    enabled: !!selected,
  });
  const [version, setVersion] = useState(""),
    [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [pendingAccess, setPendingAccess] = useState<{
    id: string;
    enabled: boolean;
    publicAccess: boolean;
  } | null>(null);
  const manage = ["owner", "org_admin", "workspace_admin", "builder"].includes(
    role,
  );
  const current =
    detail.data?.versions.find((v) => v.id === version) ??
    detail.data?.versions[0];
  async function refresh() {
    await cache.invalidateQueries({ queryKey: ["agent-skills", workspaceId] });
    await cache.invalidateQueries({ queryKey: ["agent-skill"] });
  }
  async function update(enabled: boolean, publicAccess: boolean) {
    if (!detail.data) return;
    setBusy(true);
    setError("");
    setPendingAccess({ id: selected, enabled, publicAccess });
    try {
      await requestJson(`/agent-skills/${selected}`, "PUT", {
        enabled,
        publicAccess,
        revision: detail.data.revision,
      });
      await refresh();
      setNotice(
        "Skill access updated. Existing agent version pins are unchanged.",
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPendingAccess(null);
      setBusy(false);
    }
  }
  return (
    <section className="panel skills-studio">
      <div className="panel-header">
        <div>
          <h2>Agent skills</h2>
          <p>Reusable instructions and text references for your agents.</p>
        </div>
        {manage && (
          <Button
            disabled={busy}
            onClick={() => {
              setTarget("");
              input.current?.click();
            }}
          >
            Upload skill
          </Button>
        )}
      </div>
      <input
        ref={input}
        type="file"
        disabled={!manage || busy}
        accept=".md,.zip"
        className="sr-only"
        aria-label="Upload skill file"
        onChange={async (event) => {
          const file = event.target.files?.[0];
          if (!file) return;
          event.target.value = "";
          if (file.size > 5000000) {
            setError("Skill uploads are limited to 5 MB.");
            return;
          }
          setBusy(true);
          setError("");
          setNotice("");
          try {
            const body = new FormData();
            body.append("file", file);
            const response = await fetch(
              apiBase +
                (target
                  ? `/agent-skills/${target}/versions`
                  : `/workspaces/${workspaceId}/agent-skills/upload`),
              { method: "POST", credentials: "include", body },
            );
            const result = await response.json();
            if (!response.ok)
              throw new Error(result.error ?? "Unable to upload skill");
            setSelected(result.id);
            setVersion(result.versionId);
            await refresh();
            setNotice(
              `Uploaded ${result.name} · Version ${result.version}. Review it before attaching to an agent.`,
            );
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      />
      <div className="settings-hint">
        <span>Upload SKILL.md or one skill folder in a ZIP</span>
        <HelpTooltip label="Supported skill uploads">
          UTF-8 instructions and Markdown, text, CSV, JSON or YAML references.
          Uploads are limited to 5 MB, 64 ZIP entries and 1 MB expanded. Scripts
          and binary assets are not executed or retained as runtime files.
          Skills do not grant tool permissions. Instructions and selected text
          references are sent to the agent’s configured model; do not upload
          secrets.
        </HelpTooltip>
      </div>
      {(error || list.error || detail.error) && (
        <p className="error-banner" role="alert">
          {error || list.error?.message || detail.error?.message}
          <Button
            className="secondary"
            onClick={() => {
              void list.refetch();
              void detail.refetch();
            }}
          >
            Reload skills
          </Button>
        </p>
      )}
      {notice && (
        <p role="status" className="notice">
          {notice}
        </p>
      )}
      {busy && <p role="status">Saving skill…</p>}
      <div className="skills-layout">
        <div className="skills-list" aria-label="Workspace skills">
          {list.isPending ? (
            <p>Loading skills…</p>
          ) : (
            !list.data?.length && (
              <div className="empty">
                <h3>No agent skills yet</h3>
                <p>
                  Upload a reusable procedure, then attach it in Agent Configure
                  → Skills.
                </p>
              </div>
            )
          )}
          {list.data?.map((skill) => (
            <button
              key={skill.id}
              className="skill-card"
              aria-pressed={selected === skill.id}
              onClick={() => {
                setSelected(skill.id);
                setVersion("");
                setError("");
              }}
            >
              <strong>{skill.name}</strong>
              <span>{skill.description}</span>
              <small>
                Version {skill.version} ·{" "}
                {skill.enabled ? "Enabled" : "Disabled"} ·{" "}
                {skill.public_access
                  ? "Public chat approved"
                  : "Workspace only"}
              </small>
            </button>
          ))}
        </div>
        {detail.data && current && (
          <div className="skill-detail">
            <div className="skill-detail-heading">
              <h3>{detail.data.name}</h3>
              {manage && (
                <Button
                  className="secondary"
                  disabled={busy}
                  onClick={() => {
                    setTarget(selected);
                    input.current?.click();
                  }}
                >
                  Upload new version
                </Button>
              )}
            </div>
            <label>
              Skill version
              <select
                aria-label="Skill version"
                value={current.id}
                onChange={(e) => setVersion(e.target.value)}
              >
                {detail.data.versions.map((v) => (
                  <option key={v.id} value={v.id}>
                    Version {v.version} · {v.name}
                  </option>
                ))}
              </select>
            </label>
            {manage && (
              <div className="skill-access-controls">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={
                      pendingAccess?.id === detail.data.id
                        ? pendingAccess.enabled
                        : detail.data.enabled
                    }
                    disabled={busy}
                    onChange={(e) =>
                      void update(e.target.checked, detail.data!.public_access)
                    }
                  />
                  Enable skill
                </label>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={
                      pendingAccess?.id === detail.data.id
                        ? pendingAccess.publicAccess
                        : detail.data.public_access
                    }
                    disabled={busy}
                    onChange={(e) =>
                      void update(detail.data!.enabled, e.target.checked)
                    }
                  />
                  Allow in public chat
                  <HelpTooltip label="About public skill access">
                    A public agent may send these instructions to its model and
                    include derived content in customer replies. Review the
                    complete skill before approving public access. Revoking
                    access prevents future runtime loading.
                  </HelpTooltip>
                </label>
              </div>
            )}
            {!!current.warnings.length && (
              <div role="status" className="notice">
                {current.warnings.map((warning) => (
                  <p key={warning}>{warning}</p>
                ))}
              </div>
            )}
            <div className="skill-instructions">
              <ChatMarkdown content={current.instructions} />
            </div>
            {!!current.reference_files.length && (
              <details>
                <summary>
                  Text references ({current.reference_files.length})
                </summary>
                {current.reference_files.map((file) => (
                  <details key={file.path}>
                    <summary>{file.path}</summary>
                    <pre>{file.content}</pre>
                  </details>
                ))}
              </details>
            )}
            {!!current.ignored_files.length && (
              <details>
                <summary>
                  Unsupported files — not executable (
                  {current.ignored_files.length})
                </summary>
                <ul>
                  {current.ignored_files.map((file) => (
                    <li key={file}>{file}</li>
                  ))}
                </ul>
              </details>
            )}
            {manage && (
              <Button
                className="secondary"
                disabled={busy}
                onClick={async () => {
                  if (
                    !window.confirm(
                      "Archive this skill? Agents will stop loading it; their version pins and run history remain.",
                    )
                  )
                    return;
                  setBusy(true);
                  setError("");
                  try {
                    await requestJson(`/agent-skills/${selected}`, "DELETE");
                    setSelected("");
                    await refresh();
                    setNotice(
                      "Skill archived. Remove its attachment from agent drafts before publishing.",
                    );
                  } catch (e) {
                    setError((e as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Archive skill
              </Button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
