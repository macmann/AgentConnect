"use client";
import { useEffect, useState, type FormEvent } from "react";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import * as Dialog from "@radix-ui/react-dialog";
import {
  ArrowUpRight,
  Boxes,
  ChevronDown,
  ChevronRight,
  Check,
  FolderKanban,
  KeyRound,
  Layers,
  LayoutDashboard,
  LogOut,
  Plus,
  Search,
  ShieldCheck,
  Sparkles,
  Users,
  Workflow,
  X,
  Activity,
  BookOpen,
} from "lucide-react";
import { Button } from "./button";
import { CollectedData } from "./collected-data";
import { OperationsStudio } from "./operations-studio";
import { WorkflowStudio } from "./workflow-studio";
import { ToolStudio } from "./tool-studio";
import { KnowledgeStudio } from "./knowledge-studio";
import { AgentStudio, Models, Conversations } from "./agent-studio";
const base = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const response = await fetch(base + path, {
    method,
    credentials: "include",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "Request failed");
  return data as T;
}
type User = {
  id: string;
  name: string;
  email: string;
  verified: boolean;
  verificationRequired?: boolean;
};
type Organization = { id: string; name: string };
type Workspace = { id: string; name: string; role: string };
type Member = { id: string; name: string; email: string; role: string };
type Secret = { id: string; name: string; created_at: string };
type Audit = { id: string; action: string; created_at: string };
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});
export function Console() {
  return (
    <QueryClientProvider client={queryClient}>
      <Studio />
    </QueryClientProvider>
  );
}
const authSchema = z.object({
  name: z.string().min(1).max(100),
  email: z.email(),
  password: z.string().min(12).max(128),
});
function Auth({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<"register" | "login" | "reset">("register");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const form = useForm<z.infer<typeof authSchema>>({
    resolver: zodResolver(
      mode === "reset"
        ? authSchema.extend({ password: z.string() })
        : authSchema,
    ),
    defaultValues: { name: "Member", email: "", password: "" },
  });
  async function submit(values: z.infer<typeof authSchema>) {
    setError("");
    try {
      if (mode === "reset") {
        await api("/auth/password-reset/request", "POST", {
          email: values.email,
        });
        setNotice("If this account exists, a reset email has been queued.");
      } else {
        await api(`/auth/${mode}`, "POST", values);
        onDone();
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <div className="auth">
      <div className="auth-story">
        <div className="brand">
          <Boxes /> AgentConnect
        </div>
        <span className="eyebrow">THE ENTERPRISE AGENT WORKSPACE</span>
        <h1>
          From possibility.
          <br />
          To production.
        </h1>
        <p>
          A shared foundation for building, orchestrating, and governing your AI
          workforce.
        </p>
        <div className="auth-feature">
          <ShieldCheck /> Tenant isolation by design
        </div>
        <div className="auth-feature">
          <Layers /> One workspace. Endless possibilities.
        </div>
        <small>PHASE 0 · FOUNDATION</small>
      </div>
      <div className="auth-form">
        <div className="eyebrow">WELCOME TO AGENTCONNECT</div>
        <h2>
          {mode === "register"
            ? "Create your account"
            : mode === "login"
              ? "Welcome back"
              : "Reset your password"}
        </h2>
        <p className="muted">
          {mode === "register"
            ? "Your next chapter starts with a secure workspace."
            : "Sign in to your enterprise workspace."}
        </p>
        <form onSubmit={form.handleSubmit(submit)}>
          {mode === "register" && (
            <label>
              Your name
              <input {...form.register("name")} autoComplete="name" />
            </label>
          )}
          <label>
            Work email
            <input
              {...form.register("email")}
              type="email"
              autoComplete="email"
            />
          </label>
          {mode !== "reset" && (
            <label>
              Password
              <input
                {...form.register("password")}
                type="password"
                autoComplete={
                  mode === "register" ? "new-password" : "current-password"
                }
              />
              <small>Use at least 12 characters.</small>
            </label>
          )}
          {Object.values(form.formState.errors).map((e, i) => (
            <p className="error" key={i}>
              {e.message}
            </p>
          ))}
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          {notice && <p role="status">{notice}</p>}
          <Button disabled={form.formState.isSubmitting} type="submit">
            {form.formState.isSubmitting
              ? "Please wait…"
              : mode === "register"
                ? "Create account"
                : mode === "login"
                  ? "Sign in"
                  : "Send reset email"}
            <ArrowUpRight size={17} />
          </Button>
        </form>
        <button
          className="text-button"
          onClick={() => setMode(mode === "register" ? "login" : "register")}
        >
          {mode === "register"
            ? "Already have an account? Sign in"
            : "New here? Create an account"}
        </button>
        <button className="text-button" onClick={() => setMode("reset")}>
          Forgot password?
        </button>
        <p className="fine">Your data stays in your organization. Always.</p>
      </div>
    </div>
  );
}
function Studio() {
  const cache = useQueryClient();
  const user = useQuery({
    queryKey: ["me"],
    queryFn: () => api<User>("/auth/me"),
  });
  const orgs = useQuery({
    queryKey: ["organizations"],
    queryFn: () => api<Organization[]>("/organizations"),
    enabled: !!user.data,
  });
  const [orgId, setOrgId] = useState("");
  const [workspaceId, setWorkspaceId] = useState("");
  const [view, setView] = useState("Overview");
  const [dialog, setDialog] = useState<
    "organization" | "workspace" | "invite" | "secret" | null
  >(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [editingSecret, setEditingSecret] = useState<Secret | null>(null);
  const [action, setAction] = useState("");
  const [actionToken, setActionToken] = useState("");
  const [actionPassword, setActionPassword] = useState("");
  const [search, setSearch] = useState("");
  useEffect(() => {
    function captureAction() {
      const p = new URLSearchParams(window.location.hash.slice(1));
      const pending = p.get("action");
      const raw = p.get("token");
      if (!raw || !pending || !["verify", "invite", "reset"].includes(pending))
        return;
      setAction(pending);
      setActionToken(raw);
      window.history.replaceState({}, "", window.location.pathname);
    }
    captureAction();
    window.addEventListener("hashchange", captureAction);
    return () => window.removeEventListener("hashchange", captureAction);
  }, []);
  const currentOrgId = orgId || orgs.data?.[0]?.id || "";
  const org = orgs.data?.find((o) => o.id === currentOrgId);
  const workspaces = useQuery({
    queryKey: ["workspaces", currentOrgId],
    queryFn: () =>
      api<Workspace[]>(`/organizations/${currentOrgId}/workspaces`),
    enabled: !!currentOrgId,
  });
  const currentWorkspace =
    workspaces.data?.find((w) => w.id === workspaceId) || workspaces.data?.[0];
  const wid = currentWorkspace?.id;
  const members = useQuery({
    queryKey: ["members", wid],
    queryFn: () => api<Member[]>(`/workspaces/${wid}/members`),
    enabled: !!wid,
  });
  const manage = ["owner", "org_admin", "workspace_admin"].includes(
    currentWorkspace?.role ?? "",
  );
  const secrets = useQuery({
    queryKey: ["secrets", wid],
    queryFn: () => api<Secret[]>(`/workspaces/${wid}/secrets`),
    enabled: !!wid && manage,
  });
  const audit = useQuery({
    queryKey: ["audit", wid],
    queryFn: () => api<Audit[]>(`/workspaces/${wid}/audit`),
    enabled:
      !!wid &&
      ["owner", "org_admin", "workspace_admin", "analyst"].includes(
        currentWorkspace?.role ?? "",
      ),
  });
  async function mutate(task: () => Promise<unknown>, message: string) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await task();
      await cache.invalidateQueries();
      setNotice(message);
      setDialog(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const name = String(f.get("name") ?? "");
    if (dialog === "organization")
      await mutate(
        () => api("/organizations", "POST", { name }),
        "Organization created",
      );
    if (dialog === "workspace")
      await mutate(
        () =>
          api(`/organizations/${currentOrgId}/workspaces`, "POST", { name }),
        "Workspace created",
      );
    if (dialog === "invite")
      await mutate(
        () =>
          api(`/organizations/${currentOrgId}/invitations`, "POST", {
            email: f.get("email"),
            role: f.get("role"),
            workspaceId: wid,
          }),
        "Invitation queued for email delivery",
      );
    if (dialog === "secret")
      await mutate(
        () =>
          api(
            editingSecret
              ? `/workspaces/${wid}/secrets/${editingSecret.id}`
              : `/workspaces/${wid}/secrets`,
            editingSecret ? "PUT" : "POST",
            editingSecret
              ? { value: f.get("value") }
              : { name, value: f.get("value") },
          ),
        "Encrypted secret saved",
      );
  }
  const tokenPanel = action && (
    <div className="token-panel">
      <h3>
        {action === "verify"
          ? "Verify email"
          : action === "invite"
            ? "Accept workspace invitation"
            : "Reset password"}
      </h3>
      <p>Confirm the action from your email.</p>
      {action === "reset" && (
        <label>
          New password
          <input
            type="password"
            minLength={12}
            value={actionPassword}
            onChange={(e) => setActionPassword(e.target.value)}
          />
        </label>
      )}
      <Button
        disabled={busy}
        onClick={() =>
          mutate(async () => {
            await api(
              action === "verify"
                ? "/auth/verify"
                : action === "invite"
                  ? "/invitations/accept"
                  : "/auth/password-reset/confirm",
              "POST",
              { token: actionToken, password: actionPassword },
            );
            setAction("");
          }, "Action completed")
        }
      >
        Confirm
      </Button>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </div>
  );
  if (user.isPending)
    return <main className="loading">Connecting to your workspace…</main>;
  if (!user.data)
    return (
      <>
        {tokenPanel}
        <Auth onDone={() => cache.invalidateQueries()} />
      </>
    );
  const filtered = (workspaces.data ?? []).filter((w) =>
    w.name.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <div className="shell">
      <aside className="sidebar">
        <a className="brand" href="/">
          <div className="brand-icon">
            <Boxes size={21} />
          </div>
          AgentConnect
        </a>
        <div className="org-picker">
          <div className="org-avatar">{(org?.name ?? "W").slice(0, 1)}</div>
          <label>
            <span>Organization</span>
            <select
              aria-label="Organization"
              value={currentOrgId}
              onChange={(e) => {
                setOrgId(e.target.value);
                setWorkspaceId("");
              }}
            >
              {!org && <option value="">Create an organization</option>}
              {orgs.data?.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </label>
          <ChevronDown size={14} />
        </div>
        <div className="nav-label">WORKSPACE</div>
        <nav>
          {[
            { label: "Overview", icon: LayoutDashboard },
            { label: "Workspaces", icon: FolderKanban },
            { label: "Agents", icon: Sparkles },
            { label: "Models", icon: Boxes },
            { label: "Knowledge", icon: BookOpen },
            { label: "Tools", icon: Boxes },
            { label: "Workflows", icon: Workflow },
            { label: "Conversations", icon: Activity },
            { label: "Operations", icon: Activity },
            { label: "Collected data", icon: Layers },
            { label: "Members", icon: Users },
            { label: "Secrets", icon: KeyRound },
            { label: "Audit log", icon: Activity },
          ].map(({ label, icon: Icon }) => (
            <button
              key={label}
              className={view === label ? "active" : ""}
              onClick={() => {
                setView(label);
                setError("");
              }}
            >
              <Icon size={18} />
              {label}
              {label === "Overview" && <span className="nav-dot" />}
            </button>
          ))}
        </nav>
        <div className="nav-label roadmap-label">BUILD ROADMAP</div>
        <div className="future">
          <Workflow size={17} /> Workflows <span>Phase 4</span>
        </div>
        <div className="sidebar-bottom">
          <div className="foundation-note">
            <ShieldCheck size={19} />
            <strong>A secure place to start</strong>
            <p>
              Your foundation is ready for the next generation of AI agents.
            </p>
            <span>Foundation release · 0.1</span>
          </div>
          <button
            className="profile"
            onClick={() =>
              mutate(() => api("/auth/logout", "POST"), "Signed out")
            }
          >
            <div className="avatar">{user.data.name.slice(0, 1)}</div>
            <div>
              <strong>{user.data.name}</strong>
              <small>{user.data.email}</small>
            </div>
            <LogOut size={16} />
          </button>
        </div>
      </aside>
      <div className="main">
        <header>
          <div className="breadcrumb">
            Workspace <ChevronRight size={14} />
            <strong>{view}</strong>
          </div>
          <div className="header-right">
            <span className="environment-dot" /> Development{" "}
            <span className="divider" />
            <span className="avatar small">{user.data.name.slice(0, 1)}</span>
          </div>
        </header>
        <main className="content">
          {tokenPanel}
          {!user.data.verified && user.data.verificationRequired !== false && (
            <div className="verify-banner">
              <ShieldCheck size={18} />
              <span>
                Verify your email to create your organization. A verification
                link has been sent to your inbox.
              </span>
              <button
                onClick={() =>
                  mutate(
                    () => api("/auth/verification", "POST"),
                    "Verification email queued",
                  )
                }
              >
                Resend email
              </button>
            </div>
          )}
          <div className="page-title">
            <div>
              <div className="eyebrow">YOUR COMMAND CENTER</div>
              <h1>
                {view === "Overview"
                  ? `Good to see you, ${user.data.name.split(" ")[0]}.`
                  : view}
              </h1>
              <p className="muted">
                {view === "Overview"
                  ? "A clear view of your workspace. A strong foundation for what comes next."
                  : view === "Operations"
                    ? "Monitor usage, review answers and manage workspace access."
                    : "Manage your organization with clear permissions and a complete audit trail."}
              </p>
            </div>
            <Button
              onClick={() =>
                setDialog(currentOrgId ? "workspace" : "organization")
              }
            >
              <Plus size={17} />
              {currentOrgId ? "New workspace" : "Create organization"}
            </Button>
          </div>
          {error && (
            <div role="alert" className="error-banner">
              {error}
            </div>
          )}
          {notice && (
            <div role="status" className="notice">
              <Check size={17} />
              {notice}
            </div>
          )}
          {[
            "Agents",
            "Models",
            "Conversations",
            "Operations",
            "Collected data",
            "Knowledge",
            "Tools",
            "Workflows",
          ].includes(view) &&
            (!wid ? (
              <p className="empty">Choose or create a workspace first.</p>
            ) : view === "Agents" ? (
              <AgentStudio
                onNavigate={setView}
                key={wid}
                workspaceId={wid}
                role={currentWorkspace?.role ?? "viewer"}
              />
            ) : view === "Collected data" ? (
              <CollectedData key={wid} workspaceId={wid} />
            ) : view === "Operations" ? (
              <OperationsStudio
                key={wid}
                workspaceId={wid}
                role={currentWorkspace?.role ?? "viewer"}
              />
            ) : view === "Workflows" ? (
              <WorkflowStudio
                key={wid}
                workspaceId={wid}
                role={currentWorkspace?.role ?? "viewer"}
              />
            ) : view === "Tools" ? (
              <ToolStudio
                key={wid}
                workspaceId={wid}
                role={currentWorkspace?.role ?? "viewer"}
              />
            ) : view === "Knowledge" ? (
              <KnowledgeStudio
                key={wid}
                workspaceId={wid}
                role={currentWorkspace?.role ?? "viewer"}
              />
            ) : view === "Models" ? (
              <Models
                key={wid}
                workspaceId={wid}
                role={currentWorkspace?.role ?? "viewer"}
              />
            ) : (
              <Conversations
                key={wid}
                workspaceId={wid}
                role={currentWorkspace?.role ?? "viewer"}
              />
            ))}
          {view === "Overview" && (
            <>
              <div className="hero">
                <div>
                  <span className="hero-tag">
                    <span /> BUILT FOR WHAT’S NEXT
                  </span>
                  <h2>
                    Your AI journey starts
                    <br />
                    with the right foundation.
                  </h2>
                  <p>
                    Bring your team together. Organize your work.
                    <br />
                    Keep every connection secure.
                  </p>
                  <Button
                    onClick={() =>
                      setDialog(currentOrgId ? "workspace" : "organization")
                    }
                  >
                    {currentOrgId
                      ? "Create a workspace"
                      : "Create your organization"}
                    <ArrowUpRight size={16} />
                  </Button>
                </div>
                <div className="hero-art" aria-hidden="true">
                  <div className="orbit orbit-one" />
                  <div className="orbit orbit-two" />
                  <div className="art-node node-one">
                    <Users />
                  </div>
                  <div className="art-node node-two">
                    <ShieldCheck />
                  </div>
                  <div className="art-node node-three">
                    <Layers />
                  </div>
                  <div className="art-core">
                    <Boxes size={55} />
                  </div>
                  <span className="art-label">CONNECTED BY DESIGN</span>
                </div>
              </div>
              <div className="metrics">
                {[
                  {
                    label: "Workspaces",
                    value: workspaces.data?.length ?? 0,
                    icon: FolderKanban,
                    detail: "Spaces to build together",
                  },
                  {
                    label: "Workspace members",
                    value: members.data?.length ?? 0,
                    icon: Users,
                    detail: "People in your selected workspace",
                  },
                  {
                    label: "Encrypted secrets",
                    value: manage ? (secrets.data?.length ?? 0) : "—",
                    icon: KeyRound,
                    detail: "Credentials kept server-side",
                  },
                  {
                    label: "Your access",
                    value:
                      currentWorkspace?.role?.replaceAll("_", " ") ?? "Member",
                    icon: ShieldCheck,
                    detail: "Enforced at the API boundary",
                  },
                ].map(({ label, value, icon: Icon, detail }) => (
                  <div className="metric" key={label}>
                    <div>
                      <span>{label}</span>
                      <Icon size={18} />
                    </div>
                    <strong>{value}</strong>
                    <small>{detail}</small>
                  </div>
                ))}
              </div>
            </>
          )}
          {(view === "Overview" || view === "Workspaces") && (
            <section className="panel">
              <div className="panel-header">
                <div>
                  <h3>
                    Your workspaces{" "}
                    <span className="count">
                      {workspaces.data?.length ?? 0}
                    </span>
                  </h3>
                  <p>Dedicated spaces for your team and ideas.</p>
                </div>
                <label className="search">
                  <Search size={16} />
                  <input
                    aria-label="Search workspaces"
                    placeholder="Search workspaces…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </label>
              </div>
              {workspaces.isPending && currentOrgId ? (
                <p className="empty">Loading workspaces…</p>
              ) : filtered.length ? (
                <div className="workspace-grid">
                  {filtered.map((w) => (
                    <button
                      className={`workspace-card ${wid === w.id ? "selected" : ""}`}
                      key={w.id}
                      onClick={() => setWorkspaceId(w.id)}
                    >
                      <div className="workspace-icon">
                        <FolderKanban size={23} />
                      </div>
                      <div>
                        <h4>{w.name}</h4>
                        <p>{w.role.replaceAll("_", " ")}</p>
                      </div>
                      <ArrowUpRight size={17} />
                      <span className="workspace-footer">
                        <span className="status-dot" />{" "}
                        {wid === w.id
                          ? "Selected workspace"
                          : "Select workspace"}
                      </span>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="empty">
                  <div className="empty-icon">
                    <FolderKanban size={28} />
                  </div>
                  <h3>
                    {search
                      ? "No matching workspaces"
                      : "Make room for your next idea"}
                  </h3>
                  <p>
                    {search
                      ? "Try a different workspace name."
                      : "Create a workspace to bring your team, secrets, and audit history together."}
                  </p>
                  {!search && (
                    <Button
                      className="secondary"
                      onClick={() =>
                        setDialog(currentOrgId ? "workspace" : "organization")
                      }
                    >
                      <Plus size={16} />{" "}
                      {currentOrgId
                        ? "Create workspace"
                        : "Create organization"}
                    </Button>
                  )}
                </div>
              )}
            </section>
          )}
          {view === "Members" && (
            <section className="panel">
              <div className="panel-header">
                <div>
                  <h3>Workspace members</h3>
                  <p>{currentWorkspace?.name ?? "Select a workspace first"}</p>
                </div>
                {manage && (
                  <Button onClick={() => setDialog("invite")}>
                    <Plus size={16} />
                    Invite member
                  </Button>
                )}
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Member</th>
                      <th>Email</th>
                      <th>Role</th>
                    </tr>
                  </thead>
                  <tbody>
                    {members.data?.map((m) => (
                      <tr key={m.id}>
                        <td>{m.name}</td>
                        <td>{m.email}</td>
                        <td>
                          <span className="badge">
                            {m.role.replaceAll("_", " ")}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!members.data?.length && (
                <p className="empty">
                  Choose or create a workspace to manage members.
                </p>
              )}
            </section>
          )}
          {view === "Secrets" && (
            <section className="panel">
              <div className="panel-header">
                <div>
                  <h3>Workspace secrets</h3>
                  <p>
                    Encrypted at rest. Values are never returned to your
                    browser.
                  </p>
                </div>
                {manage && (
                  <Button
                    onClick={() => {
                      setEditingSecret(null);
                      setError("");
                      setDialog("secret");
                    }}
                  >
                    <Plus size={16} />
                    Add secret
                  </Button>
                )}
              </div>
              {manage ? (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>Created</th>
                        <th>Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {secrets.data?.map((s) => (
                        <tr key={s.id}>
                          <td>
                            <KeyRound size={14} /> {s.name}
                          </td>
                          <td>{new Date(s.created_at).toLocaleDateString()}</td>
                          <td>
                            <button
                              className="text-button"
                              disabled={busy}
                              onClick={() => {
                                setEditingSecret(s);
                                setError("");
                                setDialog("secret");
                              }}
                            >
                              Edit
                            </button>
                            <button
                              className="text-button"
                              disabled={busy}
                              onClick={() => {
                                if (
                                  !window.confirm(
                                    `Delete secret ${s.name}? This cannot be undone.`,
                                  )
                                )
                                  return;
                                void mutate(
                                  () =>
                                    api(
                                      `/workspaces/${wid}/secrets/${s.id}`,
                                      "DELETE",
                                    ),
                                  "Secret deleted",
                                );
                              }}
                            >
                              Delete
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {!secrets.data?.length && (
                    <p className="empty">
                      No secrets yet. Add a credential when an integration needs
                      it.
                    </p>
                  )}
                </div>
              ) : (
                <p className="empty">
                  Secret management requires workspace administrator access.
                </p>
              )}
            </section>
          )}
          {view === "Audit log" && (
            <section className="panel">
              <div className="panel-header">
                <div>
                  <h3>Recent activity</h3>
                  <p>
                    Latest 100 events in{" "}
                    {currentWorkspace?.name ?? "your workspace"}.
                  </p>
                </div>
                <span className="badge">
                  <ShieldCheck size={13} /> Audit trail
                </span>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Action</th>
                      <th>Time</th>
                      <th>Event ID</th>
                    </tr>
                  </thead>
                  <tbody>
                    {audit.data?.map((a) => (
                      <tr key={a.id}>
                        <td>{a.action}</td>
                        <td>{new Date(a.created_at).toLocaleString()}</td>
                        <td className="mono">{a.id.slice(0, 8)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {audit.error && <p className="error">{audit.error.message}</p>}
                {!audit.data?.length && (
                  <p className="empty">
                    No visible events. Workspace creation and changes will
                    appear here.
                  </p>
                )}
              </div>
            </section>
          )}
          {view === "Overview" && (
            <div className="bottom-grid">
              <section className="panel next-panel">
                <span className="eyebrow">THE NEXT CHAPTER</span>
                <h3>From a workspace to an AI workforce.</h3>
                <p>
                  Knowledge retrieval and visual orchestration are planned in
                  the phased product roadmap.
                </p>
                <div className="phase-row">
                  <span className="phase complete">
                    <Check size={13} /> Foundation
                  </span>
                  <ChevronRight size={13} />
                  <span className="phase">Agent MVP</span>
                  <ChevronRight size={13} />
                  <span className="phase">Knowledge</span>
                </div>
              </section>
              <section className="panel security-panel">
                <div className="security-symbol">
                  <ShieldCheck size={27} />
                </div>
                <h3>Security is the starting point.</h3>
                <p>
                  Tenant-scoped access, encrypted secrets, secure sessions, and
                  audited changes.
                </p>
                <button
                  className="text-button"
                  onClick={() => setView("Audit log")}
                >
                  View audit activity <ArrowUpRight size={14} />
                </button>
              </section>
            </div>
          )}
          <footer>
            <span>
              AgentConnect{" "}
              <span className="muted">/ Enterprise AI, connected.</span>
            </span>
            <span>
              <span className="status-dot" /> Foundation release
            </span>
          </footer>
        </main>
      </div>
      <Dialog.Root
        open={!!dialog}
        onOpenChange={(open) => {
          if (!open) {
            setDialog(null);
            setError("");
          }
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content className="dialog-content">
            <Dialog.Title>
              {dialog === "organization"
                ? "Create organization"
                : dialog === "workspace"
                  ? "Create workspace"
                  : dialog === "invite"
                    ? "Invite a teammate"
                    : editingSecret
                      ? "Edit encrypted secret"
                      : "Add encrypted secret"}
            </Dialog.Title>
            <Dialog.Description>
              {dialog === "secret"
                ? editingSecret
                  ? "Enter a replacement value. Existing model and connector references are preserved. The current value is never returned."
                  : "The value is encrypted server-side and never returned."
                : "Build a shared, secure place for your team."}
            </Dialog.Description>
            <Dialog.Close className="dialog-close" aria-label="Close">
              <X size={18} />
            </Dialog.Close>
            <form onSubmit={create}>
              {dialog === "invite" ? (
                <>
                  <label>
                    Email
                    <input name="email" type="email" required />
                  </label>
                  <label>
                    Workspace role
                    <select name="role">
                      {[
                        "viewer",
                        "builder",
                        "operator",
                        "analyst",
                        "workspace_admin",
                      ].map((role) => (
                        <option key={role} value={role}>
                          {role.replaceAll("_", " ")}
                        </option>
                      ))}
                    </select>
                  </label>
                </>
              ) : (
                <label>
                  {dialog === "secret" ? "Secret name" : "Name"}
                  <input
                    name="name"
                    defaultValue={
                      dialog === "secret" ? (editingSecret?.name ?? "") : ""
                    }
                    readOnly={dialog === "secret" && !!editingSecret}
                    required
                    maxLength={100}
                    pattern={
                      dialog === "secret" ? "[A-Z][A-Z0-9_]{1,63}" : undefined
                    }
                    placeholder={
                      dialog === "secret"
                        ? "PROVIDER_API_KEY"
                        : "e.g. Customer experience"
                    }
                  />
                </label>
              )}
              {dialog === "secret" && (
                <label>
                  Value
                  <input
                    name="value"
                    type="password"
                    required
                    autoComplete="off"
                    maxLength={16384}
                  />
                </label>
              )}
              {error && (
                <p role="alert" className="error">
                  {error}
                </p>
              )}
              <Button disabled={busy} type="submit">
                {busy
                  ? "Saving…"
                  : dialog === "invite"
                    ? "Send invitation"
                    : "Save"}
                <ArrowUpRight size={16} />
              </Button>
            </form>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
