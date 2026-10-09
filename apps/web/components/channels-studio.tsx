"use client";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  widgetSettings,
  type WidgetSettings,
} from "@agentconnect/schemas/channels";
import { permitted, type Role } from "@agentconnect/schemas/foundation";
import { apiBase, requestJson } from "./agent-client";
import { Button } from "./button";
type Deployment = {
  id: string;
  name: string;
  agent_name: string;
  enabled: boolean;
  widget_settings: Partial<WidgetSettings>;
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
  return (
    <div className="channels-layout">
      <section className="panel">
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
          {deployments.data?.map((d) => (
            <details key={d.id}>
              <summary>
                {d.name} · {d.agent_name}
                {!d.enabled ? " · Disabled" : ""}
              </summary>
              <WidgetEditor
                deployment={d}
                workspaceId={workspaceId}
                manage={permitted(role, "operations:manage")}
              />
            </details>
          ))}
          <p className="muted">
            WhatsApp and Messenger connectors and provider real-time voice are
            planned integrations. Browser voice is available in agent playground
            and hosted chat.
          </p>
        </div>
      </section>
      <section className="panel">
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
  const [settings, setSettings] = useState(() =>
      widgetSettings.parse(deployment.widget_settings),
    ),
    [origins, setOrigins] = useState(
      (deployment.widget_settings.allowedOrigins ?? []).join("\n"),
    ),
    [error, setError] = useState(""),
    [saved, setSaved] = useState(false),
    [busy, setBusy] = useState(false);
  const cache = useQueryClient();
  function field<K extends keyof WidgetSettings>(
    key: K,
    value: WidgetSettings[K],
  ) {
    setSettings((s) => ({ ...s, [key]: value }));
    setSaved(false);
  }
  async function save() {
    setError("");
    setBusy(true);
    try {
      const s = widgetSettings.parse({
        ...settings,
        allowedOrigins: origins
          .split(/\n|,/)
          .map((s) => s.trim())
          .filter(Boolean),
      });
      await requestJson(
        `/workspaces/${workspaceId}/channels/${deployment.id}`,
        "PUT",
        s,
      );
      setSettings(s);
      setSaved(true);
      await cache.invalidateQueries({ queryKey: ["channels", workspaceId] });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const attributes = `src="${apiBase}/widget.js" data-deployment="${deployment.id}" data-chat-url="${typeof window !== "undefined" ? window.location.origin : ""}/chat/${deployment.id}"`;
  return (
    <div className="studio-form">
      <fieldset disabled={!manage || busy}>
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
              field("access", e.target.value as WidgetSettings["access"])
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
              value={origins}
              placeholder="https://www.example.com"
              onChange={(e) => {
                setOrigins(e.target.value);
                setSaved(false);
              }}
            />
            <small>
              Exact origins, one per line. Include port when needed. HTTP is
              only supported on localhost.
            </small>
          </label>
        )}
        <div className="form-grid">
          <label>
            Theme
            <select
              value={settings.theme}
              onChange={(e) =>
                field("theme", e.target.value as WidgetSettings["theme"])
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
                field("position", e.target.value as WidgetSettings["position"])
              }
            >
              <option>right</option>
              <option>left</option>
            </select>
          </label>
          <label>
            Launcher text
            <input
              value={settings.launcher}
              maxLength={30}
              onChange={(e) => field("launcher", e.target.value)}
            />
          </label>
          <label>
            Language
            <input
              value={settings.language}
              onChange={(e) => field("language", e.target.value)}
            />
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
          Greeting
          <input
            value={settings.greeting}
            maxLength={300}
            onChange={(e) => field("greeting", e.target.value)}
          />
        </label>
        <Button type="button" onClick={() => void save()}>
          Save widget settings
        </Button>
      </fieldset>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {saved && <p role="status">Widget settings saved.</p>}
      <label>
        Website embed code
        <textarea readOnly value={`<script async ${attributes}></script>`} />
      </label>
      <p className="muted">
        Add this script before your website’s closing body tag. The widget
        displays text summaries; full generated components are available in
        hosted chat. No API key belongs in this snippet.
      </p>
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
      setText("");
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
