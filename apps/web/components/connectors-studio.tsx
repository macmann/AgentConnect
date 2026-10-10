"use client";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { permitted, type Role } from "@agentconnect/schemas/foundation";
import { requestJson } from "./agent-client";
import { Button } from "./button";
type Connector = {
  id: string;
  name: string;
  kind: "s3" | "google-drive";
  knowledge_name: string;
  knowledge_base_id: string;
  secret_id: string;
  revision: number;
  enabled: boolean;
  schedule_minutes: number | null;
  next_sync_at: string | null;
  status: string | null;
  error_code: string | null;
  selection: {
    endpoint?: string;
    region?: string;
    bucket?: string;
    prefix?: string;
    folderId?: string;
    recursive?: boolean;
    maxObjects: number;
  };
};
type Sync = {
  id: string;
  status: string;
  counts: Record<string, number>;
  error_code: string | null;
  created_at: string;
};
export function ConnectorsStudio({
  workspaceId,
  role,
  onNavigate,
}: {
  workspaceId: string;
  role: Role;
  onNavigate: (view: string) => void;
}) {
  const base = `/workspaces/${workspaceId}`,
    cache = useQueryClient(),
    canRead = permitted(role, "connector:read"),
    canManage = permitted(role, "connector:manage"),
    canSync = permitted(role, "connector:sync");
  const connectors = useQuery({
    queryKey: ["connectors", workspaceId],
    queryFn: () => requestJson<Connector[]>(base + "/connectors"),
    enabled: canRead,
    refetchInterval: 5000,
  });
  const knowledge = useQuery({
    queryKey: ["connector-bases", workspaceId],
    queryFn: () =>
      requestJson<{ id: string; name: string }[]>(base + "/knowledge-bases"),
    enabled: canManage,
  });
  const secrets = useQuery({
    queryKey: ["connector-secrets", workspaceId],
    queryFn: () =>
      requestJson<{ id: string; name: string }[]>(base + "/secrets"),
    enabled: canManage,
  });
  const [selected, setSelected] = useState(""),
    [editing, setEditing] = useState(false),
    [name, setName] = useState(""),
    [kind, setKind] = useState<"s3" | "google-drive">("s3"),
    [folderId, setFolderId] = useState(""),
    [recursive, setRecursive] = useState(true),
    [kb, setKb] = useState(""),
    [secret, setSecret] = useState(""),
    [endpoint, setEndpoint] = useState("https://s3.us-east-1.amazonaws.com"),
    [region, setRegion] = useState("us-east-1"),
    [bucket, setBucket] = useState(""),
    [prefix, setPrefix] = useState(""),
    [schedule, setSchedule] = useState(""),
    [limit, setLimit] = useState(100),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  const connector = connectors.data?.find((c) => c.id === selected);
  const history = useQuery({
    queryKey: ["connector-history", workspaceId, selected],
    queryFn: () =>
      requestJson<Sync[]>(base + "/connectors/" + selected + "/syncs"),
    enabled: canRead && !!selected,
    refetchInterval: 3000,
  });
  async function action(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
      await cache.invalidateQueries({
        predicate: (q) => String(q.queryKey[0]).startsWith("connector"),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }
  function edit(c?: Connector) {
    setSelected(c?.id ?? "");
    setEditing(true);
    setName(c?.name ?? "");
    setKind(c?.kind ?? "s3");
    setFolderId(c?.selection.folderId ?? "");
    setRecursive(c?.selection.recursive ?? true);
    setKb(c?.knowledge_base_id ?? "");
    setSecret(c?.secret_id ?? "");
    setEndpoint(c?.selection.endpoint ?? "https://s3.us-east-1.amazonaws.com");
    setRegion(c?.selection.region ?? "us-east-1");
    setBucket(c?.selection.bucket ?? "");
    setPrefix(c?.selection.prefix ?? "");
    setLimit(c?.selection.maxObjects ?? 100);
    setSchedule(c?.schedule_minutes?.toString() ?? "");
    setError("");
    setNotice("");
  }
  if (!canRead)
    return (
      <section className="panel">
        <p className="empty">
          Ask a workspace administrator for connector access.
        </p>
      </section>
    );
  return (
    <div className="connector-layout">
      <section className="panel">
        <div className="panel-header">
          <div>
            <h3>Enterprise sources</h3>
            <p>
              Sync approved S3 files or Google Drive folders into a knowledge
              base.
            </p>
          </div>
          {canManage && <Button onClick={() => edit()}>Add connector</Button>}
        </div>
        <div className="studio-form">
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          {notice && <p role="status">{notice}</p>}
          {[connectors.error, knowledge.error, secrets.error, history.error]
            .filter(Boolean)
            .map((e, i) => (
              <p className="error" key={i}>
                {e!.message}
              </p>
            ))}
          {connectors.isPending && <p>Loading connectors…</p>}
          {connectors.data?.length === 0 && !editing && (
            <div className="empty">
              <h4>No enterprise sources yet</h4>
              <p>
                Create a knowledge base and save a source credential, then
                connect an S3 prefix or Google Drive folder.
              </p>
              <div className="button-row">
                <Button onClick={() => onNavigate("Knowledge")}>
                  Create a knowledge base
                </Button>
                {canManage && (
                  <Button onClick={() => onNavigate("Secrets")}>
                    Add source credential
                  </Button>
                )}
              </div>
            </div>
          )}
          {connectors.data?.map((c) => (
            <button
              className="connector-choice"
              key={c.id}
              onClick={() => {
                setSelected(c.id);
                setEditing(false);
                setError("");
                setNotice("");
              }}
            >
              <strong>{c.name}</strong>
              <span>
                {c.knowledge_name} ·{" "}
                {c.kind === "s3"
                  ? `${c.selection.bucket}/${c.selection.prefix}`
                  : `Google Drive folder ${c.selection.folderId}`}{" "}
                · {c.enabled ? (c.status ?? "Not synced") : "Paused"}
              </span>
            </button>
          ))}
          {editing && canManage && (
            <>
              <h4>
                {connector ? "Edit connector" : "Connect a document source"}
              </h4>
              <label>
                Provider
                <select
                  aria-label="Connector provider"
                  disabled={!!connector}
                  value={kind}
                  onChange={(e) =>
                    setKind(e.target.value as "s3" | "google-drive")
                  }
                >
                  <option value="s3">S3 / S3-compatible</option>
                  <option value="google-drive">Google Drive</option>
                </select>
              </label>
              <label>
                Name
                <input
                  aria-label="Connector name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={100}
                />
              </label>
              <label>
                Knowledge base
                <select
                  aria-label="Connector knowledge base"
                  disabled={!!connector}
                  value={kb}
                  onChange={(e) => setKb(e.target.value)}
                >
                  <option value="">Select knowledge base</option>
                  {knowledge.data?.map((k) => (
                    <option key={k.id} value={k.id}>
                      {k.name}
                    </option>
                  ))}
                </select>
              </label>
              {knowledge.data?.length === 0 && (
                <Button onClick={() => onNavigate("Knowledge")}>
                  Create a knowledge base
                </Button>
              )}
              <label>
                Workspace credential
                <select
                  aria-label="Source workspace credential"
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                >
                  <option value="">Select JSON credential</option>
                  {secrets.data?.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
              <p>
                {kind === "s3"
                  ? "Save a JSON secret with accessKeyId, secretAccessKey and optional sessionToken. Grant only ListBucket and GetObject for the selected prefix."
                  : "Enable Google Drive API in your Google Cloud project. Save the service-account JSON key in Secrets, then share this folder with its client_email as Viewer. Tokens refresh automatically; no user impersonation is used."}{" "}
                Values remain encrypted on the server.
              </p>
              <Button onClick={() => onNavigate("Secrets")}>
                Open Secrets
              </Button>
              {kind === "s3" ? (
                <>
                  <label>
                    S3 endpoint
                    <input
                      aria-label="S3 endpoint"
                      disabled={!!connector}
                      value={endpoint}
                      onChange={(e) => setEndpoint(e.target.value)}
                    />
                  </label>
                  <p>
                    The exact host must be approved in CONNECTOR_ALLOWED_HOSTS
                    on the API and worker. Trusted private servers require an
                    explicit CONNECTOR_PRIVATE_HOSTS exception.
                  </p>
                  <label>
                    Region
                    <input
                      aria-label="S3 region"
                      disabled={!!connector}
                      value={region}
                      onChange={(e) => setRegion(e.target.value)}
                    />
                  </label>
                  <label>
                    Bucket
                    <input
                      aria-label="S3 bucket"
                      disabled={!!connector}
                      value={bucket}
                      onChange={(e) => setBucket(e.target.value)}
                    />
                  </label>
                  <label>
                    Folder prefix
                    <input
                      aria-label="S3 prefix"
                      disabled={!!connector}
                      value={prefix}
                      onChange={(e) => setPrefix(e.target.value)}
                      placeholder="documents/"
                    />
                  </label>
                  <p>
                    Use a trailing slash to select a folder. An empty prefix
                    selects the whole bucket. Source location and knowledge base
                    are fixed after creation; create another connector to change
                    them.
                  </p>
                </>
              ) : (
                <>
                  <label>
                    Google Drive folder ID
                    <input
                      aria-label="Google Drive folder ID"
                      value={folderId}
                      disabled={!!connector}
                      onChange={(e) => setFolderId(e.target.value)}
                      placeholder="ID from drive.google.com/drive/folders/…"
                    />
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      aria-label="Include subfolders"
                      checked={recursive}
                      disabled={!!connector}
                      onChange={(e) => setRecursive(e.target.checked)}
                    />{" "}
                    Include subfolders
                  </label>
                  <p>
                    Approve www.googleapis.com and oauth2.googleapis.com in
                    CONNECTOR_ALLOWED_HOSTS on both API and worker. Folder and
                    target knowledge base are fixed after creation. Google Docs,
                    Sheets and Slides are exported; shortcuts are skipped.
                    Imported files inherit knowledge base access, so choose a
                    folder whose documents can be shared with that audience.
                  </p>
                </>
              )}
              <label>
                Maximum listed objects
                <input
                  aria-label="Maximum listed objects"
                  type="number"
                  min={1}
                  max={1000}
                  value={limit}
                  onChange={(e) => setLimit(Number(e.target.value))}
                />
              </label>
              <p>
                A listing above this limit fails without removing sources. Files
                must be supported document formats and at most 10 MB.
              </p>
              <label>
                Refresh schedule
                <select
                  aria-label="Refresh schedule"
                  value={schedule}
                  onChange={(e) => setSchedule(e.target.value)}
                >
                  <option value="">Manual only</option>
                  <option value="15">Every 15 minutes</option>
                  <option value="60">Hourly</option>
                  <option value="1440">Daily</option>
                  <option value="10080">Weekly</option>
                </select>
              </label>
              <Button
                disabled={
                  busy ||
                  !name.trim() ||
                  !kb ||
                  !secret ||
                  (kind === "s3" ? !bucket : !folderId)
                }
                onClick={() =>
                  void action(async () => {
                    if (connector) {
                      await requestJson(
                        base + "/connectors/" + connector.id,
                        "PUT",
                        {
                          revision: connector.revision,
                          maxObjects: limit,
                          name,
                          secretId: secret,
                          enabled: connector.enabled,
                          scheduleMinutes: schedule ? Number(schedule) : null,
                        },
                      );
                    } else {
                      const created = await requestJson<{ id: string }>(
                        base + "/connectors",
                        "POST",
                        {
                          name,
                          kind,
                          knowledgeBaseId: kb,
                          secretId: secret,
                          selection:
                            kind === "s3"
                              ? {
                                  endpoint,
                                  region,
                                  bucket,
                                  prefix,
                                  maxObjects: limit,
                                }
                              : { folderId, recursive, maxObjects: limit },
                          scheduleMinutes: schedule ? Number(schedule) : null,
                        },
                      );
                      setSelected(created.id);
                    }
                    setEditing(false);
                    setNotice(
                      "Connector saved. Run Sync now to verify access and import files.",
                    );
                  })
                }
              >
                Save connector
              </Button>
            </>
          )}
          {connector && !editing && (
            <>
              <h4>{connector.name}</h4>
              <p>
                Knowledge base: {connector.knowledge_name}.{" "}
                {connector.schedule_minutes
                  ? `Refresh every ${connector.schedule_minutes} minutes.`
                  : "Manual refresh only."}{" "}
                {connector.next_sync_at
                  ? `Next refresh: ${new Date(connector.next_sync_at).toLocaleString()}.`
                  : ""}
              </p>
              <p>
                Sync imports files and queues document parsing/embedding
                separately. Open Knowledge to check source readiness before
                attaching it to an agent.
              </p>
              <div className="button-row">
                {canSync && (
                  <Button
                    disabled={
                      busy ||
                      !connector.enabled ||
                      ["queued", "running"].includes(connector.status ?? "")
                    }
                    onClick={() =>
                      void action(async () => {
                        await requestJson(
                          base + "/connectors/" + connector.id + "/sync",
                          "POST",
                        );
                        setNotice("Sync queued. Status updates automatically.");
                      })
                    }
                  >
                    Sync now
                  </Button>
                )}
                <Button onClick={() => onNavigate("Knowledge")}>
                  Open Knowledge
                </Button>
                {canManage && (
                  <>
                    <Button onClick={() => edit(connector)}>
                      Edit connector
                    </Button>
                    <Button
                      disabled={busy}
                      onClick={() =>
                        void action(async () => {
                          await requestJson(
                            base + "/connectors/" + connector.id,
                            "PUT",
                            {
                              revision: connector.revision,
                              name: connector.name,
                              secretId: connector.secret_id,
                              enabled: !connector.enabled,
                              scheduleMinutes: connector.schedule_minutes,
                            },
                          );
                          setNotice(
                            connector.enabled
                              ? "Connector paused. Imported knowledge is retained."
                              : "Connector resumed.",
                          );
                        })
                      }
                    >
                      {connector.enabled
                        ? "Pause connector"
                        : "Resume connector"}
                    </Button>
                    <Button
                      disabled={busy}
                      onClick={() =>
                        void action(async () => {
                          await requestJson(
                            base + "/connectors/" + connector.id,
                            "DELETE",
                          );
                          setSelected("");
                          setNotice(
                            "Connector disconnected. Imported knowledge is retained; remove sources in Knowledge if needed.",
                          );
                        })
                      }
                    >
                      Disconnect connector
                    </Button>
                  </>
                )}
              </div>
            </>
          )}
        </div>
      </section>
      {connector && !editing && (
        <section className="panel">
          <div className="panel-header">
            <div>
              <h3>Sync history</h3>
              <p>
                Changed objects replace their managed source revision. Remote
                removals are applied after a complete scan. Pausing or
                disconnecting retains imported knowledge.
              </p>
            </div>
          </div>
          <div className="studio-form">
            {history.data?.length === 0 && (
              <p>No sync runs yet. Use Sync now to test access.</p>
            )}
            {history.data?.map((s) => (
              <article className="connector-run" key={s.id}>
                <strong>
                  {s.status} · {new Date(s.created_at).toLocaleString()}
                </strong>
                <p>
                  {Object.entries(s.counts)
                    .map(([key, value]) => `${key}: ${value}`)
                    .join(" · ")}
                </p>
                {s.error_code && (
                  <p className="error" role="alert">
                    {s.error_code}
                    {s.error_code === "CONNECTOR_SOURCE_LIMIT"
                      ? " — Choose a narrower source or increase the configured listing limit."
                      : s.error_code === "CONNECTOR_ACCESS_DENIED"
                        ? connector.kind === "google-drive"
                          ? " — Check the service-account key, enable Drive API, and share the selected folder with client_email as Viewer."
                          : " — Check the selected credential, bucket/prefix permissions and region."
                        : s.error_code === "CONNECTOR_FOLDER_UNAVAILABLE"
                          ? " — Check the folder ID, trash status and service-account sharing."
                          : s.error_code === "CONNECTOR_INCOMPLETE_LISTING"
                            ? " — Google returned an incomplete search. Retry; existing knowledge was retained."
                            : s.error_code === "CONNECTOR_OBJECT_CHANGED"
                              ? " — A file changed during download. Retry the sync."
                              : ""}
                  </p>
                )}
                {canSync && ["queued", "running"].includes(s.status) && (
                  <Button
                    disabled={busy}
                    onClick={() =>
                      void action(async () => {
                        await requestJson(
                          base +
                            "/connectors/" +
                            connector.id +
                            "/syncs/" +
                            s.id +
                            "/cancel",
                          "POST",
                        );
                        setNotice(
                          "Sync cancelled. Previously imported files remain.",
                        );
                      })
                    }
                  >
                    Cancel sync
                  </Button>
                )}
              </article>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
