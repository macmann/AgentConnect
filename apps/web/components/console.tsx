"use client";
import { SupportStudio } from "./support-studio";
import { RetentionStudio } from "./retention-studio";
import { ConnectorsStudio } from "./connectors-studio";
import { QualityStudio } from "./quality-studio";
import { Fragment, useEffect, useRef, useState, type FormEvent } from "react";
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
  UserRoundCheck,
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
  Menu,
  Cable,
  Wrench,
  MessagesSquare,
  Radio,
  ChartNoAxesColumn,
  ListChecks,
  ClipboardList,
  Plus,
  Search,
  ShieldCheck,
  Sparkles,
  Users,
  Workflow,
  X,
  BookOpen,
} from "lucide-react";
import { Button } from "./button";
import { CollectedData } from "./collected-data";
import { ChannelsStudio } from "./channels-studio";
import { OperationsStudio } from "./operations-studio";
import { WorkflowStudio } from "./workflow-studio";
import { ToolStudio } from "./tool-studio";
import { KnowledgeStudio } from "./knowledge-studio";
import { requestAgentLeave } from "./agent-configure-state";
import { AgentStudio, Models, Conversations } from "./agent-studio";
import { ApiError, requestJson as api } from "./agent-client";
type User = {
  id: string;
  name: string;
  email: string;
  verified: boolean;
  verificationRequired?: boolean;
};
type Organization = { id: string; name: string };
type Workspace = {
  id: string;
  name: string;
  role: import("@agentconnect/schemas/foundation").Role;
};
type Member = { id: string; name: string; email: string; role: string };
type Secret = { id: string; name: string; created_at: string };
type Audit = { id: string; action: string; created_at: string };
const navigationGroups: Record<string, string> = {
  Overview: "Workspace",
  Agents: "Build",
  "Human Support": "Support",
  Conversations: "Monitor",
  Members: "Manage",
};
const pageDescriptions: Record<string, string> = {
  Overview: "Your workspace, team and next steps in one place.",
  Workspaces: "Choose a workspace or create a shared space for your team.",
  Agents:
    "Configure assistants, connect knowledge and tools, then test and publish.",
  Models: "Manage model providers, credentials and connection settings.",
  Knowledge: "Add sources and build knowledge bases for grounded answers.",
  Tools: "Register approved tools your agents can use.",
  Workflows: "Build and test workflows that coordinate your agents.",
  Connectors: "Connect external services and manage synchronized sources.",
  Conversations: "Review conversations, answers and execution details.",
  Operations: "Monitor activity, usage and workspace health.",
  "Collected data": "Review information collected through your agents.",
  Channels: "Publish your agents to the channels your users visit.",
  "Human Support":
    "Handle customer requests, collaborate privately and return conversations to AI.",
  Quality: "Evaluate answers and compare performance over time.",
  Members: "Manage workspace membership and access permissions.",
  Secrets: "Store and rotate encrypted credentials for models and connectors.",
  Retention: "Control how long workspace data is kept and preview cleanup.",
  "Audit log": "Review a record of changes made in this workspace.",
};
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
        <small>YOUR AI WORKSPACE</small>
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
          onClick={() => {
            setMode(mode === "register" ? "login" : "register");
            setError("");
            setNotice("");
            form.clearErrors();
          }}
        >
          {mode === "register"
            ? "Already have an account? Sign in"
            : "New here? Create an account"}
        </button>
        <button
          className="text-button"
          onClick={() => {
            setMode("reset");
            setError("");
            setNotice("");
            form.clearErrors();
          }}
        >
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
  const [view, setViewState] = useState("Overview");
  const [menuOpen, setMenuOpen] = useState(false);
  const dialogOpener = useRef<HTMLElement | null>(null);
  const agentRoute = useRef("");
  function setView(destination: string) {
    if (destination !== view && !requestAgentLeave()) return;
    setViewState(destination);
    setMenuOpen(false);
    setError("");
    setNotice("");
    const params = new URLSearchParams(window.location.hash.slice(1));
    params.set("view", destination);
    params.delete("action");
    params.delete("token");
    window.history.pushState({}, "", `#${params}`);
    agentRoute.current = window.location.hash;
    window.scrollTo({ top: 0, behavior: "instant" });
  }
  useEffect(() => {
    const rememberAgentRoute = () => {
      agentRoute.current = window.location.hash;
    };
    window.addEventListener("agent-studio:navigated", rememberAgentRoute);
    window.addEventListener("workspace-section:navigated", rememberAgentRoute);
    const restore = () => {
      const params = new URLSearchParams(window.location.hash.slice(1));
      const previous = new URLSearchParams(agentRoute.current.slice(1));
      if (
        ["view", "organization", "workspace", "agent"].some(
          (key) => params.get(key) !== previous.get(key),
        ) &&
        !requestAgentLeave()
      ) {
        window.history.pushState({}, "", agentRoute.current);
        return;
      }
      agentRoute.current = window.location.hash;
      const destination = params.get("view") ?? "Overview";
      setViewState(destination in pageDescriptions ? destination : "Overview");
      setOrgId(params.get("organization") ?? "");
      setWorkspaceId(params.get("workspace") ?? "");
      setError("");
      setNotice("");
      setMenuOpen(false);
    };
    restore();
    window.addEventListener("popstate", restore);
    window.addEventListener("hashchange", restore);
    return () => {
      window.removeEventListener("agent-studio:navigated", rememberAgentRoute);
      window.removeEventListener(
        "workspace-section:navigated",
        rememberAgentRoute,
      );
      window.removeEventListener("popstate", restore);
      window.removeEventListener("hashchange", restore);
    };
  }, []);
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
  const currentOrgId =
    orgs.data?.find((o) => o.id === orgId)?.id || orgs.data?.[0]?.id || "";
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
  function selectWorkspace(id: string) {
    if (id !== workspaceId && !requestAgentLeave()) return;
    setWorkspaceId(id);
    setError("");
    setNotice("");
    const params = new URLSearchParams(window.location.hash.slice(1));
    params.set("view", view);
    params.set("organization", currentOrgId);
    params.set("workspace", id);
    params.delete("supportCase");
    params.delete("agent");
    params.delete("stage");
    params.delete("section");
    window.history.pushState({}, "", `#${params}`);
    agentRoute.current = window.location.hash;
  }
  function selectOrganization(id: string) {
    if (id !== orgId && !requestAgentLeave()) return;
    setOrgId(id);
    setWorkspaceId("");
    setError("");
    setNotice("");
    const params = new URLSearchParams({ view, organization: id });
    window.history.pushState({}, "", `#${params}`);
    agentRoute.current = window.location.hash;
  }
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
      await mutate(async () => {
        const created = await api<Organization>("/organizations", "POST", {
          name,
        });
        selectOrganization(created.id);
      }, "Organization created");
    if (dialog === "workspace")
      await mutate(async () => {
        const created = await api<Workspace>(
          `/organizations/${currentOrgId}/workspaces`,
          "POST",
          { name },
        );
        selectWorkspace(created.id);
      }, "Workspace created");
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
  if (
    !user.data &&
    user.error &&
    !(user.error instanceof ApiError && user.error.status === 401)
  )
    return (
      <main className="connection-state">
        <Boxes size={36} />
        <h1>Unable to connect</h1>
        <p role="alert">{user.error.message}</p>
        <Button onClick={() => user.refetch()}>Try again</Button>
      </main>
    );
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
  const navigation = (
    <div className="sidebar-body">
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
              selectOrganization(e.target.value);
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
      <nav aria-label="Workspace navigation">
        {[
          { label: "Overview", icon: LayoutDashboard },
          { label: "Workspaces", icon: FolderKanban },
          { label: "Agents", icon: Sparkles },
          { label: "Models", icon: Boxes },
          { label: "Knowledge", icon: BookOpen },
          { label: "Connectors", icon: Cable },
          { label: "Tools", icon: Wrench },
          { label: "Workflows", icon: Workflow },
          { label: "Human Support", icon: UserRoundCheck },
          { label: "Conversations", icon: MessagesSquare },
          { label: "Operations", icon: ChartNoAxesColumn },
          { label: "Collected data", icon: Layers },
          { label: "Channels", icon: Radio },
          { label: "Quality", icon: ListChecks },
          { label: "Members", icon: Users },
          { label: "Secrets", icon: KeyRound },
          { label: "Retention", icon: ShieldCheck },
          { label: "Audit log", icon: ClipboardList },
        ].map(({ label, icon: Icon }) => (
          <Fragment key={label}>
            {navigationGroups[label] && (
              <div className="nav-label">{navigationGroups[label]}</div>
            )}
            <button
              aria-current={view === label ? "page" : undefined}
              className={view === label ? "active" : ""}
              onClick={() => {
                setView(label);
                setError("");
              }}
            >
              <Icon size={18} />
              {label}
            </button>
          </Fragment>
        ))}
      </nav>
      <div className="sidebar-bottom">
        <button
          className="profile"
          aria-label="Sign out"
          title="Sign out"
          disabled={busy}
          onClick={() =>
            mutate(async () => {
              if (!requestAgentLeave()) return;
              await api("/auth/logout", "POST");
              cache.clear();
              setViewState("Overview");
              setOrgId("");
              setWorkspaceId("");
              window.history.replaceState({}, "", window.location.pathname);
            }, "Signed out")
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
    </div>
  );
  return (
    <div className="shell">
      <a
        className="skip-link"
        href="#workspace-content"
        onClick={(event) => {
          event.preventDefault();
          document.getElementById("workspace-content")?.focus();
          window.scrollTo({ top: 0, behavior: "instant" });
        }}
      >
        Skip to content
      </a>
      <aside className="sidebar">{navigation}</aside>
      <Dialog.Root open={menuOpen} onOpenChange={setMenuOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay navigation-overlay" />
          <Dialog.Content
            className="navigation-drawer"
            id="mobile-navigation"
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              document
                .querySelector<HTMLButtonElement>(".mobile-menu")
                ?.focus();
            }}
          >
            <Dialog.Title className="sr-only">
              Workspace navigation
            </Dialog.Title>
            <Dialog.Description className="sr-only">
              Choose an organization or page.
            </Dialog.Description>
            <Dialog.Close
              className="dialog-close"
              aria-label="Close navigation"
            >
              <X size={20} />
            </Dialog.Close>
            {navigation}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      <div className="main">
        <header className="workspace-header">
          <button
            className="mobile-menu button secondary"
            aria-label="Open navigation"
            aria-expanded={menuOpen}
            aria-controls="mobile-navigation"
            onClick={() => setMenuOpen(true)}
          >
            <Menu size={20} />
          </button>
          <label className="workspace-switcher">
            <span>Workspace</span>
            <select
              aria-label="Current workspace"
              value={wid ?? ""}
              onChange={(e) => selectWorkspace(e.target.value)}
            >
              {!wid && <option value="">No workspace selected</option>}
              {workspaces.data?.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </label>
          <div className="breadcrumb">
            Workspace <ChevronRight size={14} />
            <strong>{view}</strong>
          </div>
          <div className="header-right">
            <span className="environment-dot" />{" "}
            {currentWorkspace?.role.replaceAll("_", " ") ?? "Account"}{" "}
            <span className="divider" />
            <span className="avatar small">{user.data.name.slice(0, 1)}</span>
          </div>
        </header>
        <main className="content" id="workspace-content" tabIndex={-1}>
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
              <p className="muted">{pageDescriptions[view]}</p>
            </div>
            {["Overview", "Workspaces"].includes(view) &&
              (!currentOrgId ||
                !currentWorkspace ||
                ["owner", "org_admin"].includes(
                  currentWorkspace?.role ?? "",
                )) && (
                <Button
                  onClick={() =>
                    setDialog(currentOrgId ? "workspace" : "organization")
                  }
                >
                  <Plus size={17} />
                  {currentOrgId ? "New workspace" : "Create organization"}
                </Button>
              )}
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
            "Human Support",
            "Retention",
            "Agents",
            "Models",
            "Conversations",
            "Operations",
            "Collected data",
            "Channels",
            "Quality",
            "Knowledge",
            "Connectors",
            "Tools",
            "Workflows",
          ].includes(view) &&
            (!wid ? (
              <p className="empty">Choose or create a workspace first.</p>
            ) : view === "Human Support" ? (
              <SupportStudio
                key={wid}
                workspaceId={wid}
                userId={user.data.id}
                role={currentWorkspace?.role ?? "viewer"}
              />
            ) : view === "Retention" ? (
              <RetentionStudio
                key={wid}
                workspaceId={wid}
                role={currentWorkspace?.role ?? "viewer"}
              />
            ) : view === "Agents" ? (
              <AgentStudio
                onNavigate={setView}
                key={wid}
                workspaceId={wid}
                role={currentWorkspace?.role ?? "viewer"}
              />
            ) : view === "Connectors" ? (
              <ConnectorsStudio
                key={wid}
                workspaceId={wid}
                role={currentWorkspace?.role ?? "viewer"}
                onNavigate={setView}
              />
            ) : view === "Quality" ? (
              <QualityStudio
                key={wid}
                workspaceId={wid}
                role={currentWorkspace?.role ?? "viewer"}
                onNavigate={setView}
              />
            ) : view === "Channels" ? (
              <ChannelsStudio
                key={wid}
                workspaceId={wid}
                role={currentWorkspace?.role ?? "viewer"}
                onNavigate={setView}
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
                    Build useful agents.
                    <br />
                    Bring your knowledge to work.
                  </h2>
                  <p>
                    Connect a model, add your knowledge and tools,
                    <br />
                    then test an assistant before publishing.
                  </p>
                  <Button
                    onClick={() =>
                      wid
                        ? setView("Agents")
                        : setDialog(currentOrgId ? "workspace" : "organization")
                    }
                  >
                    {wid
                      ? "Explore your agents"
                      : currentOrgId
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
                      onClick={() => selectWorkspace(w.id)}
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
              {members.isFetching && (
                <p className="empty" role="status">
                  Loading members…
                </p>
              )}
              {members.error && (
                <p className="error-banner" role="alert">
                  {members.error.message}
                </p>
              )}
              {!members.isFetching &&
                !members.error &&
                !members.data?.length && (
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
                  {secrets.isFetching && (
                    <p className="empty" role="status">
                      Loading secrets…
                    </p>
                  )}
                  {secrets.error && (
                    <p className="error-banner" role="alert">
                      {secrets.error.message}
                    </p>
                  )}
                  {!secrets.isFetching &&
                    !secrets.error &&
                    !secrets.data?.length && (
                      <p className="empty">
                        No secrets yet. Add a credential when an integration
                        needs it.
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
                {audit.isFetching && (
                  <p className="empty" role="status">
                    Loading audit activity…
                  </p>
                )}
                {!audit.isFetching && !audit.error && !audit.data?.length && (
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
                <span className="eyebrow">BUILD YOUR WORKSPACE</span>
                <h3>From a workspace to an AI workforce.</h3>
                <p>
                  Connect your sources in Knowledge, attach them to an agent,
                  then coordinate multiple agents in Workflows.
                </p>
                <div className="quick-links">
                  <Button
                    className="secondary"
                    onClick={() => setView("Models")}
                  >
                    Manage models <ArrowUpRight size={14} />
                  </Button>
                  <Button
                    className="secondary"
                    onClick={() => setView("Knowledge")}
                  >
                    Add knowledge <ArrowUpRight size={14} />
                  </Button>
                  <Button
                    className="secondary"
                    onClick={() => setView("Workflows")}
                  >
                    Build a workflow <ArrowUpRight size={14} />
                  </Button>
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
              <span className="status-dot" /> Workspace console
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
          <Dialog.Content
            className="dialog-content"
            onOpenAutoFocus={() => {
              dialogOpener.current = document.activeElement as HTMLElement;
            }}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              dialogOpener.current?.focus();
            }}
          >
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
