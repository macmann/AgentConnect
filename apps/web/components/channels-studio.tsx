"use client";
import { SettingsHint } from "./settings-help";
import { MessagingChannels } from "./messaging-channels";
import { CustomerBranding } from "./customer-branding";
import { useMemo, useState, useId } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  widgetSettings,
  type WidgetSettings,
} from "@agentconnect/schemas/channels";
import { permitted, type Role } from "@agentconnect/schemas/foundation";
import { DeploymentEmbed } from "./deployment-embed";
import { requestJson } from "./agent-client";
import {
  WorkspaceSections,
  useWorkspaceSection,
  useWorkspaceLeaveGuard,
} from "./workspace-sections";
import { Button } from "./button";
import {
  branding,
  type Branding,
} from "@agentconnect/schemas/customer-experience";
import { WidgetLivePreview } from "./widget-live-preview";
import type { QuickAction } from "@agentconnect/schemas/bank-experience";
type Deployment = {
  id: string;
  name: string;
  agent_name: string;
  enabled: boolean;
  widget_settings: Partial<WidgetSettings>;
  branding?: unknown;
  published_name: string;
  published_welcome: string;
  conversation_starters: string[];
  quick_actions: QuickAction[];
};
export function ChannelsStudio({
  workspaceId,
  role,
  onNavigate,
}: {
  workspaceId: string;
  role: Role;
  onNavigate: (view: string) => void;
}) {
  const [section, setSection] = useWorkspaceSection("channelsSection", "web", [
    "web",
    "inbox",
    "messaging",
  ]);
  const deployments = useQuery({
    queryKey: ["channels", workspaceId],
    queryFn: () =>
      requestJson<Deployment[]>(`/workspaces/${workspaceId}/channels`),
  });
  const handoffs = useQuery({
    queryKey: ["handoffs", workspaceId],
    queryFn: () =>
      requestJson<
        { id: string; name: string; channel: string; handoff_status: string }[]
      >(`/workspaces/${workspaceId}/handoffs`),
    refetchInterval: 5000,
  });
  const [selected, setSelected] = useState("");
  const [selectedDeployment, setSelectedDeployment] = useState("");
  const activeDeployment =
    deployments.data?.find((d) => d.id === selectedDeployment) ??
    deployments.data?.[0];
  return (
    <div className="channels-layout">
      <section className="panel channels-section-picker">
        <WorkspaceSections
          label="Channels sections"
          value={section}
          onChange={setSection}
          sections={[
            {
              id: "messaging",
              label: "Customer messaging",
              description: "Messenger, Viber, Telegram and Microsoft Teams",
            },
            {
              id: "web",
              label: "Website widgets",
              description: "Configure a published agent for your website.",
              count: deployments.data?.length,
            },
            {
              id: "inbox",
              label: "Support requests",
              description:
                "Review customer requests that pause automated replies.",
              count: handoffs.data?.length,
            },
          ]}
        />
      </section>
      {section === "messaging" && (
        <MessagingChannels
          workspaceId={workspaceId}
          canManage={permitted(role, "operations:manage")}
          deployments={deployments.data ?? []}
        />
      )}
      <section className="panel" hidden={section !== "web"}>
        <div className="panel-header">
          <div>
            <h3>Web channels</h3>
            <p>Configure a published deployment for your website.</p>
          </div>
        </div>
        <div className="studio-form">
          {deployments.isPending && <p>Loading deployments…</p>}
          {deployments.error && (
            <p className="error" role="alert">
              {deployments.error.message}
            </p>
          )}
          {deployments.data?.length === 0 && (
            <div className="empty">
              <h4>No published deployments yet</h4>
              <p>
                Publish an agent and create a hosted deployment before adding it
                to a website.
              </p>
              <Button onClick={() => onNavigate("Agents")}>Open Agents</Button>
            </div>
          )}
          {activeDeployment && (
            <>
              <label className="widget-deployment-picker">
                Deployment
                <select
                  value={activeDeployment.id}
                  onChange={(e) => {
                    if (
                      window.dispatchEvent(
                        new Event("agent-studio:before-leave", {
                          cancelable: true,
                        }),
                      )
                    )
                      setSelectedDeployment(e.target.value);
                  }}
                >
                  {deployments.data?.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name} · {d.agent_name}
                      {!d.enabled ? " · Disabled" : ""}
                    </option>
                  ))}
                </select>
              </label>
              <WidgetEditor
                key={activeDeployment.id}
                deployment={activeDeployment}
                workspaceId={workspaceId}
                manage={permitted(role, "operations:manage")}
              />
            </>
          )}
        </div>
      </section>
      <section className="panel" hidden={section !== "inbox"}>
        <div className="panel-header">
          <div>
            <h3>Human support inbox</h3>
            <p>Open requests pause automated replies until resolved.</p>
          </div>
        </div>
        <div className="studio-form">
          {handoffs.error && (
            <p className="error" role="alert">
              {handoffs.error.message}
            </p>
          )}
          {handoffs.data?.length === 0 && (
            <p>
              No open support requests. Visitors can request human support after
              starting a chat.
            </p>
          )}
          {handoffs.data?.map((h) => (
            <Button
              key={h.id}
              className="secondary"
              onClick={() => setSelected(h.id)}
            >
              {h.name} · {h.channel} · {h.handoff_status}
            </Button>
          ))}
          {selected && (
            <OperatorThread
              key={selected}
              conversationId={selected}
              manage={permitted(role, "handoff:manage")}
            />
          )}
        </div>
      </section>
    </div>
  );
}
function WidgetEditor({
  deployment,
  workspaceId,
  manage,
}: {
  deployment: Deployment;
  workspaceId: string;
  manage: boolean;
}) {
  const initial = widgetSettings.parse(deployment.widget_settings),
    initialBranding = branding.parse(deployment.branding ?? {});
  const [settings, setSettings] = useState(initial),
    [origins, setOrigins] = useState(initial.allowedOrigins.join("\n")),
    [brandDraft, setBrandDraft] = useState<Branding>(initialBranding),
    [tab, setTab] = useState<"setup" | "appearance" | "branding" | "install">(
      "appearance",
    ),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [saved, setSaved] = useState(() =>
      JSON.stringify({ widget: initial, branding: initialBranding }),
    );
  const cache = useQueryClient(),
    tabId = useId();
  const draft = {
    widget: {
      ...settings,
      allowedOrigins: origins
        .split(/\n|,/)
        .map((s) => s.trim())
        .filter(Boolean),
    },
    branding: brandDraft,
  };
  const dirty = JSON.stringify(draft) !== saved;
  useWorkspaceLeaveGuard(dirty);
  function field<K extends keyof WidgetSettings>(
    key: K,
    value: WidgetSettings[K],
  ) {
    setSettings((s) => ({ ...s, [key]: value }));
    setNotice("");
  }
  const presentation = useMemo(
    () => ({
      name:
        brandDraft.name || deployment.published_name || deployment.agent_name,
      welcomeMessage:
        brandDraft.welcomeMessage ||
        deployment.published_welcome ||
        "How can I help you today?",
      conversationStarters: deployment.conversation_starters ?? [],
      quickActions: deployment.quick_actions ?? [],
      branding: {
        ...brandDraft,
        logoUrl: branding.shape.logoUrl.safeParse(brandDraft.logoUrl).success
          ? brandDraft.logoUrl
          : "",
      },
      widget: {
        ...settings,
        width: Number.isFinite(settings.width)
          ? Math.max(280, Math.min(600, settings.width))
          : 380,
        height: Number.isFinite(settings.height)
          ? Math.max(320, Math.min(800, settings.height))
          : 560,
      },
    }),
    [settings, brandDraft, deployment],
  );
  async function save() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const data = {
        widget: widgetSettings.parse(draft.widget),
        branding: branding.parse(brandDraft),
      };
      await requestJson(
        `/workspaces/${workspaceId}/channels/${deployment.id}/settings`,
        "PUT",
        data,
      );
      setSettings(data.widget);
      setOrigins(data.widget.allowedOrigins.join("\n"));
      setBrandDraft(data.branding);
      setSaved(JSON.stringify(data));
      setNotice("Widget settings and branding saved.");
      await cache.invalidateQueries({ queryKey: ["channels", workspaceId] });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const tabs = [
    ["setup", "Setup"],
    ["appearance", "Appearance"],
    ["branding", "Branding"],
    ["install", "Install"],
  ] as const;
  return (
    <div className="widget-workbench">
      <div className="widget-editor-controls">
        <div
          className="widget-editor-tabs"
          role="tablist"
          aria-label="Widget settings sections"
        >
          {tabs.map(([key, label], i) => (
            <button
              key={key}
              type="button"
              role="tab"
              id={`${tabId}-${key}`}
              aria-selected={tab === key}
              aria-controls={`${tabId}-panel`}
              tabIndex={tab === key ? 0 : -1}
              onClick={() => setTab(key)}
              onKeyDown={(e) => {
                const next =
                  e.key === "ArrowRight"
                    ? (i + 1) % tabs.length
                    : e.key === "ArrowLeft"
                      ? (i + tabs.length - 1) % tabs.length
                      : e.key === "Home"
                        ? 0
                        : e.key === "End"
                          ? tabs.length - 1
                          : null;
                if (next === null) return;
                e.preventDefault();
                setTab(tabs[next]![0]);
                document.getElementById(`${tabId}-${tabs[next]![0]}`)?.focus();
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <section
          id={`${tabId}-panel`}
          role="tabpanel"
          aria-labelledby={`${tabId}-${tab}`}
          className="widget-editor-panel"
        >
          <fieldset disabled={!manage || busy}>
            {tab === "setup" && (
              <>
                <h3>Website access</h3>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={settings.enabled}
                    onChange={(e) => field("enabled", e.target.checked)}
                  />
                  Enable website widget
                </label>
                <label>
                  Website access
                  <select
                    value={settings.access}
                    onChange={(e) =>
                      field(
                        "access",
                        e.target.value as WidgetSettings["access"],
                      )
                    }
                  >
                    <option value="restricted">Specific origins</option>
                    <option value="public">Any HTTPS website</option>
                  </select>
                </label>
                {settings.access === "restricted" && (
                  <label>
                    Allowed website origins
                    <textarea
                      rows={3}
                      value={origins}
                      placeholder="https://www.example.com"
                      onChange={(e) => {
                        setOrigins(e.target.value);
                        setNotice("");
                      }}
                    />
                    <small>One exact origin per line.</small>
                  </label>
                )}
                <SettingsHint label="Website access uses exact origins">
                  Include a port when needed. HTTPS is required except on
                  localhost. Previewing does not publish changes or enable
                  website access.
                </SettingsHint>
              </>
            )}
            {tab === "appearance" && (
              <>
                <h3>Widget appearance</h3>
                <div className="form-grid">
                  <label>
                    Theme
                    <select
                      value={settings.theme}
                      onChange={(e) =>
                        field(
                          "theme",
                          e.target.value as WidgetSettings["theme"],
                        )
                      }
                    >
                      <option>light</option>
                      <option>dark</option>
                    </select>
                  </label>
                  <label>
                    Position
                    <select
                      value={settings.position}
                      onChange={(e) =>
                        field(
                          "position",
                          e.target.value as WidgetSettings["position"],
                        )
                      }
                    >
                      <option>right</option>
                      <option>left</option>
                    </select>
                  </label>
                  <label>
                    Width
                    <input
                      type="number"
                      min={280}
                      max={600}
                      value={settings.width}
                      onChange={(e) => field("width", Number(e.target.value))}
                    />
                  </label>
                  <label>
                    Height
                    <input
                      type="number"
                      min={320}
                      max={800}
                      value={settings.height}
                      onChange={(e) => field("height", Number(e.target.value))}
                    />
                  </label>
                </div>
                <label>
                  Launcher text
                  <input
                    maxLength={30}
                    value={settings.launcher}
                    onChange={(e) => field("launcher", e.target.value)}
                  />
                </label>
                <label>
                  Greeting
                  <input
                    aria-label="Greeting"
                    maxLength={300}
                    value={settings.greeting}
                    onChange={(e) => field("greeting", e.target.value)}
                  />
                  <small>The branding welcome takes precedence when set.</small>
                </label>
                <label>
                  Language
                  <input
                    value={settings.language}
                    onChange={(e) => field("language", e.target.value)}
                  />
                </label>
              </>
            )}
            {tab === "branding" && (
              <>
                <h3>Customer branding</h3>
                <CustomerBranding
                  value={brandDraft}
                  onChange={(value) => {
                    setBrandDraft(value);
                    setNotice("");
                  }}
                />
              </>
            )}
          </fieldset>
          {tab === "install" && (
            <>
              <p className="muted">
                Save changes before installing. Use the floating widget for a
                launcher, or an inline iframe for hosted chat.
              </p>
              <DeploymentEmbed deploymentId={deployment.id} expanded />
            </>
          )}
        </section>
        <footer className="widget-editor-save">
          <span>{dirty ? "Unsaved changes" : "All changes saved"}</span>
          {manage && (
            <Button
              type="button"
              disabled={busy || !dirty}
              onClick={() => void save()}
            >
              {busy ? "Saving…" : "Save changes"}
            </Button>
          )}
        </footer>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {notice && <p role="status">{notice}</p>}
        {!deployment.enabled && (
          <p className="muted">
            This deployment is disabled. The preview remains available for
            editing.
          </p>
        )}
      </div>
      <WidgetLivePreview
        deploymentId={deployment.id}
        presentation={presentation}
      />
    </div>
  );
}
function OperatorThread({
  conversationId,
  manage,
}: {
  conversationId: string;
  manage: boolean;
}) {
  const cache = useQueryClient(),
    [text, setText] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const base = `/conversations/${conversationId}`;
  const thread = useQuery({
    queryKey: ["handoff-thread", conversationId],
    queryFn: () =>
      requestJson<{
        status: string;
        events: { id: string; kind: string; content: string }[];
      }>(base + "/handoff"),
    refetchInterval: 5000,
  });
  const history = useQuery({
    queryKey: ["handoff-history", conversationId],
    queryFn: () =>
      requestJson<{ id: string; role: string; content: string }[]>(
        base + "/messages",
      ),
  });
  async function act(action: string) {
    setBusy(true);
    setError("");
    try {
      await requestJson(base + "/handoff", "POST", {
        action,
        content: action === "reply" ? text : "",
      });
      if (action === "reply") setText("");
      await cache.invalidateQueries({
        queryKey: ["handoff-thread", conversationId],
      });
      await cache.invalidateQueries({ queryKey: ["handoffs"] });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="handoff-panel">
      <h4>Support conversation · {thread.data?.status}</h4>
      {thread.error && <p role="alert">{thread.error.message}</p>}
      {history.error && <p role="alert">{history.error.message}</p>}
      <details>
        <summary>Agent conversation context</summary>
        {history.data?.map((m) => (
          <p key={m.id}>
            <strong>{m.role}: </strong>
            {m.content}
          </p>
        ))}
      </details>
      {thread.data?.events.map((e) => (
        <p key={e.id}>
          <strong>
            {e.content
              ? e.kind.replaceAll("_", " ") + ":"
              : ((
                  {
                    requested: "Support requested",
                    claimed: "Operator joined",
                    resolved: "Support resolved",
                  } as Record<string, string>
                )[e.kind] ?? e.kind)}{" "}
          </strong>
          {e.content}
        </p>
      ))}
      {manage && ["pending", "active"].includes(thread.data?.status ?? "") && (
        <>
          {thread.data?.status === "pending" && (
            <Button disabled={busy} onClick={() => void act("claim")}>
              Join support conversation
            </Button>
          )}
          <label>
            Operator reply
            <textarea
              value={text}
              maxLength={4000}
              onChange={(e) => setText(e.target.value)}
            />
          </label>
          <Button
            disabled={busy || !text.trim()}
            onClick={() => void act("reply")}
          >
            Send operator reply
          </Button>
          <Button
            className="secondary"
            disabled={busy}
            onClick={() => void act("resolve")}
          >
            Resolve and return to agent
          </Button>
        </>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
