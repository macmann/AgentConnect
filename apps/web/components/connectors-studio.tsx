"use client";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { permitted, type Role } from "@agentconnect/schemas/foundation";
import { requestJson } from "./agent-client";
import { Button } from "./button";
type Connector = {
  id: string;
  name: string;
  kind: "s3" | "google-drive" | "onedrive" | "sharepoint" | "teams" | "slack";
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
    driveId?: string;
    siteId?: string;
    teamId?: string;
    channelId?: string;
    recursive?: boolean;
    maxObjects: number;
  };
};
type Site = { id: string; displayName: string; webUrl: string };
type Library = { id: string; name: string; webUrl: string };
type Folder = { id: string; name: string; webUrl: string };
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
    [kind, setKind] = useState<
      "s3" | "google-drive" | "onedrive" | "sharepoint" | "teams" | "slack"
    >("s3"),
    [teamId, setTeamId] = useState(""),
    [channelId, setChannelId] = useState(""),
    [folderId, setFolderId] = useState(""),
    [driveId, setDriveId] = useState(""),
    [siteId, setSiteId] = useState(""),
    [siteUrl, setSiteUrl] = useState(""),
    [site, setSite] = useState<Site | null>(null),
    [libraries, setLibraries] = useState<Library[]>([]),
    [folders, setFolders] = useState<Folder[]>([]),
    [breadcrumbs, setBreadcrumbs] = useState<Folder[]>([]),
    [folderConfirmed, setFolderConfirmed] = useState(false),
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
  function resetDiscovery() {
    setSite(null);
    setSiteId("");
    setLibraries([]);
    setFolders([]);
    setBreadcrumbs([]);
    setFolderConfirmed(false);
    if (kind === "sharepoint" && !connector) {
      setDriveId("");
      setFolderId("");
    }
  }
  async function browseFolder(
    libraryId: string,
    folder?: Folder,
    trail?: Folder[],
  ) {
    setFolderConfirmed(false);
    await action(async () => {
      const result = await requestJson<{ folder: Folder; folders: Folder[] }>(
        base + "/connectors/sharepoint/discover",
        "POST",
        {
          action: "folders",
          secretId: secret,
          siteId,
          driveId: libraryId,
          ...(folder ? { folderId: folder.id } : {}),
        },
      );
      setFolderId(result.folder.id);
      setFolders(result.folders);
      setBreadcrumbs(
        trail ? [...trail.slice(0, -1), result.folder] : [result.folder],
      );
      setNotice("Browse to a folder, then choose Use this folder.");
    });
  }
  function edit(c?: Connector) {
    setSelected(c?.id ?? "");
    setEditing(true);
    setName(c?.name ?? "");
    setKind(c?.kind ?? "s3");
    setSiteId(c?.selection.siteId ?? "");
    setTeamId(c?.selection.teamId ?? "");
    setChannelId(c?.selection.channelId ?? "");
    setSiteUrl("");
    setSite(null);
    setLibraries([]);
    setFolders([]);
    setBreadcrumbs([]);
    setFolderConfirmed(!!c);
    setFolderId(c?.selection.folderId ?? "");
    setDriveId(c?.selection.driveId ?? "");
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
              Sync approved document sources and Teams or Slack channels into a
              knowledge base.
            </p>
          </div>
          {canManage && (
            <Button disabled={busy} onClick={() => edit()}>
              Add connector
            </Button>
          )}
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
                connect a document folder or a Teams or Slack channel.
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
              disabled={busy}
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
                  : c.kind === "teams" || c.kind === "slack"
                    ? `${c.kind === "teams" ? "Teams" : "Slack"} channel ${c.selection.channelId}`
                    : `${c.kind === "sharepoint" ? "SharePoint" : c.kind === "onedrive" ? "OneDrive" : "Google Drive"} folder ${c.selection.folderId}`}{" "}
                · {c.enabled ? (c.status ?? "Not synced") : "Paused"}
              </span>
            </button>
          ))}
          {editing && canManage && (
            <>
              <h4>
                {connector ? "Edit connector" : "Connect a knowledge source"}
              </h4>
              <label>
                Provider
                <select
                  aria-label="Connector provider"
                  disabled={!!connector || busy}
                  value={kind}
                  onChange={(e) => {
                    resetDiscovery();
                    setDriveId("");
                    setFolderId("");
                    setTeamId("");
                    setChannelId("");
                    setKind(e.target.value as Connector["kind"]);
                  }}
                >
                  <option value="s3">S3 / S3-compatible</option>
                  <option value="google-drive">Google Drive</option>
                  <option value="onedrive">OneDrive for Business</option>
                  <option value="sharepoint">SharePoint</option>
                  <option value="teams">Microsoft Teams</option>
                  <option value="slack">Slack</option>
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
                  disabled={busy}
                  onChange={(e) => {
                    setSecret(e.target.value);
                    if (!connector && kind === "sharepoint") resetDiscovery();
                  }}
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
                  : kind === "onedrive" ||
                      kind === "sharepoint" ||
                      kind === "teams"
                    ? "Register a Microsoft Entra application with read-only Microsoft Graph application permissions and administrator consent. Save a JSON secret with tenantId, clientId and clientSecret. Access tokens renew automatically. Personal OneDrive accounts need a future delegated sign-in flow."
                    : kind === "slack"
                      ? "Save a JSON secret with token set to your Slack app user OAuth token (xoxp-...). Grant channels:read, channels:history, groups:read and groups:history for the selected channel. The authorizing user must be a channel member. Bot tokens do not support this channel-replies flow."
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
              ) : kind === "teams" || kind === "slack" ? (
                <>
                  <label>
                    {kind === "teams" ? "Teams team ID" : "Slack workspace ID"}
                    <input
                      aria-label={
                        kind === "teams"
                          ? "Teams team ID"
                          : "Slack workspace ID"
                      }
                      disabled={!!connector || busy}
                      value={teamId}
                      onChange={(e) => setTeamId(e.target.value)}
                      placeholder={
                        kind === "teams" ? "Microsoft Graph team UUID" : "T…"
                      }
                    />
                  </label>
                  <label>
                    Channel ID
                    <input
                      aria-label="Channel ID"
                      disabled={!!connector || busy}
                      value={channelId}
                      onChange={(e) => setChannelId(e.target.value)}
                      placeholder={
                        kind === "teams" ? "19:…@thread.tacv2" : "C… or G…"
                      }
                    />
                  </label>
                  <p>
                    {kind === "teams"
                      ? "Use IDs from Microsoft Graph or decode the channel link. Grant ChannelMessage.Read.All and Channel.ReadBasic.All application permissions with administrator consent. Approve graph.microsoft.com and login.microsoftonline.com in CONNECTOR_ALLOWED_HOSTS on API and worker. This release supports standard channels."
                      : "Use the workspace ID from your Slack web URL and Channel ID from channel details. Approve slack.com in CONNECTOR_ALLOWED_HOSTS on API and worker. Direct messages and externally shared channels are excluded."}
                  </p>
                  <p>
                    Messages and replies become searchable text sources. Files
                    are excluded. Set the scan limit high enough for the whole
                    channel; an incomplete scan fails without removing sources.
                    Imported content inherits knowledge base access, so select a
                    base approved for this channel’s audience. Workspace and
                    channel stay fixed after creation.
                  </p>
                </>
              ) : kind === "sharepoint" ? (
                <>
                  {connector ? (
                    <>
                      <label>
                        SharePoint site ID
                        <input
                          aria-label="SharePoint site ID"
                          value={siteId}
                          disabled
                        />
                      </label>
                      <label>
                        SharePoint library ID
                        <input
                          aria-label="SharePoint library ID"
                          value={driveId}
                          disabled
                        />
                      </label>
                      <label>
                        SharePoint folder ID
                        <input
                          aria-label="SharePoint folder ID"
                          value={folderId}
                          disabled
                        />
                      </label>
                    </>
                  ) : (
                    <>
                      <label>
                        SharePoint site URL
                        <input
                          aria-label="SharePoint site URL"
                          value={siteUrl}
                          disabled={busy}
                          placeholder="https://yourtenant.sharepoint.com/sites/Support"
                          onChange={(e) => {
                            setSiteUrl(e.target.value);
                            resetDiscovery();
                          }}
                        />
                      </label>
                      <Button
                        disabled={busy || !secret || !siteUrl.trim()}
                        onClick={() =>
                          void action(async () => {
                            const result = await requestJson<{
                              site: Site;
                              libraries: Library[];
                            }>(
                              base + "/connectors/sharepoint/discover",
                              "POST",
                              { action: "site", secretId: secret, siteUrl },
                            );
                            setSite(result.site);
                            setSiteId(result.site.id);
                            setLibraries(result.libraries);
                            setDriveId("");
                            setFolderId("");
                            setFolders([]);
                            setBreadcrumbs([]);
                            setFolderConfirmed(false);
                            setNotice(
                              result.libraries.length
                                ? "Choose a document library."
                                : "No document libraries are visible. Ask your Microsoft administrator to check application access to this site.",
                            );
                          })
                        }
                      >
                        Find site
                      </Button>
                      {site && (
                        <>
                          <p>Site: {site.displayName}</p>
                          <label>
                            Document library
                            <select
                              aria-label="SharePoint document library"
                              value={driveId}
                              disabled={busy}
                              onChange={(e) => {
                                const value = e.target.value;
                                setDriveId(value);
                                setFolderId("");
                                setFolders([]);
                                setBreadcrumbs([]);
                                setFolderConfirmed(false);
                                if (value) void browseFolder(value);
                              }}
                            >
                              <option value="">
                                Choose a document library
                              </option>
                              {libraries.map((library) => (
                                <option key={library.id} value={library.id}>
                                  {library.name}
                                </option>
                              ))}
                            </select>
                          </label>
                        </>
                      )}
                      {breadcrumbs.length > 0 && (
                        <>
                          <nav
                            aria-label="SharePoint folder path"
                            className="button-row"
                          >
                            {breadcrumbs.map((folder, index) => (
                              <Button
                                key={folder.id}
                                disabled={busy}
                                onClick={() =>
                                  void browseFolder(
                                    driveId,
                                    folder,
                                    breadcrumbs.slice(0, index + 1),
                                  )
                                }
                              >
                                {folder.name}
                              </Button>
                            ))}
                          </nav>
                          <p>Current folder: {breadcrumbs.at(-1)?.name}</p>
                          <div className="button-row">
                            {folders.map((folder) => (
                              <Button
                                key={folder.id}
                                disabled={busy}
                                onClick={() =>
                                  void browseFolder(driveId, folder, [
                                    ...breadcrumbs,
                                    folder,
                                  ])
                                }
                              >
                                Open {folder.name}
                              </Button>
                            ))}
                          </div>
                          {folders.length === 0 && (
                            <p>
                              No subfolders. You can select this folder to sync
                              its supported files.
                            </p>
                          )}
                          <Button
                            disabled={busy || folderConfirmed}
                            onClick={() => {
                              setFolderConfirmed(true);
                              setNotice(
                                `Selected folder: ${breadcrumbs.at(-1)?.name}. Save the connector to enable sync.`,
                              );
                            }}
                          >
                            Use this folder
                          </Button>
                        </>
                      )}
                    </>
                  )}
                  <label>
                    <input
                      type="checkbox"
                      aria-label="Include subfolders"
                      checked={recursive}
                      disabled={!!connector || busy}
                      onChange={(e) => setRecursive(e.target.checked)}
                    />{" "}
                    Include subfolders
                  </label>
                  <p>
                    Use a SharePoint site URL, not a file sharing URL. Grant the
                    Entra application read access to that site; Sites.Selected
                    requires a separate site read grant. Approve
                    graph.microsoft.com, login.microsoftonline.com and your
                    exact SharePoint download host in CONNECTOR_ALLOWED_HOSTS on
                    API and worker. Imported content inherits knowledge base
                    access. Site, library and folder stay fixed after creation.
                  </p>
                </>
              ) : (
                <>
                  {kind === "onedrive" && (
                    <label>
                      OneDrive drive ID
                      <input
                        aria-label="OneDrive drive ID"
                        value={driveId}
                        disabled={!!connector}
                        onChange={(e) => setDriveId(e.target.value)}
                        placeholder="Microsoft Graph drive ID"
                      />
                    </label>
                  )}
                  <label>
                    {kind === "onedrive"
                      ? "OneDrive folder item ID"
                      : "Google Drive folder ID"}
                    <input
                      aria-label={
                        kind === "onedrive"
                          ? "OneDrive folder item ID"
                          : "Google Drive folder ID"
                      }
                      value={folderId}
                      disabled={!!connector}
                      onChange={(e) => setFolderId(e.target.value)}
                      placeholder={
                        kind === "onedrive"
                          ? "Microsoft Graph folder item ID"
                          : "ID from drive.google.com/drive/folders/…"
                      }
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
                    {kind === "onedrive"
                      ? "Approve graph.microsoft.com, login.microsoftonline.com and the exact tenant download host (for example yourtenant-my.sharepoint.com) in CONNECTOR_ALLOWED_HOSTS on API and worker. Use IDs returned by Microsoft Graph, rather than a sharing URL. OneDrive shortcuts are skipped; drive, folder and target knowledge base are fixed after creation."
                      : "Approve www.googleapis.com and oauth2.googleapis.com in CONNECTOR_ALLOWED_HOSTS on both API and worker. Folder and target knowledge base are fixed after creation. Google Docs, Sheets and Slides are exported; shortcuts are skipped."}{" "}
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
                  (kind === "s3"
                    ? !bucket
                    : kind === "teams" || kind === "slack"
                      ? !teamId || !channelId
                      : !folderId ||
                        ((kind === "onedrive" || kind === "sharepoint") &&
                          !driveId)) ||
                  (kind === "sharepoint" && (!siteId || !folderConfirmed))
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
                              : kind === "teams" || kind === "slack"
                                ? { teamId, channelId, maxObjects: limit }
                                : kind === "sharepoint"
                                  ? {
                                      siteId,
                                      driveId,
                                      folderId,
                                      recursive,
                                      maxObjects: limit,
                                    }
                                  : kind === "onedrive"
                                    ? {
                                        driveId,
                                        folderId,
                                        recursive,
                                        maxObjects: limit,
                                      }
                                    : {
                                        folderId,
                                        recursive,
                                        maxObjects: limit,
                                      },
                          scheduleMinutes: schedule ? Number(schedule) : null,
                        },
                      );
                      setSelected(created.id);
                    }
                    setEditing(false);
                    setNotice(
                      "Connector saved. Run Sync now to verify access and import sources.",
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
                Sync imports sources and queues document parsing/embedding
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
                        ? connector.kind === "onedrive" ||
                          connector.kind === "sharepoint"
                          ? " — Check the Entra credential, Microsoft Graph read permissions, administrator consent and access to the selected drive."
                          : connector.kind === "google-drive"
                            ? " — Check the service-account key, enable Drive API, and share the selected folder with client_email as Viewer."
                            : " — Check the selected credential, bucket/prefix permissions and region."
                        : s.error_code === "CONNECTOR_FOLDER_UNAVAILABLE"
                          ? " — Check the folder ID and source-account access."
                          : s.error_code ===
                              "CONNECTOR_DOWNLOAD_ENDPOINT_NOT_ALLOWED"
                            ? " — Approve the exact Microsoft tenant download host in CONNECTOR_ALLOWED_HOSTS on API and worker."
                            : s.error_code === "CONNECTOR_DRIVE_UNSUPPORTED"
                              ? " — Use a OneDrive for Business or document-library drive ID. Personal accounts require delegated sign-in."
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
