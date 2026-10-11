"use client";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  messagingCredentialFields,
  type MessagingProvider,
} from "@agentconnect/schemas/messaging";
import { requestJson } from "./agent-client";
import { Button } from "./button";
type Channel = {
  id: string;
  name: string;
  provider: MessagingProvider;
  deployment_id: string;
  enabled: boolean;
  callbackUrl: string | null;
  connected_at: string | null;
  last_error: string | null;
  last_received_at?: string | null;
  settings: { identity?: string; webhookRegistered?: boolean };
};
const instructions: Record<MessagingProvider, string> = {
  telegram:
    "Create a bot with BotFather and paste its token. Connect verifies the bot and registers its webhook automatically. Customers open the bot's private chat and send a message.",
  viber:
    "Use an approved Viber bot and its authentication token. Connect verifies the bot and registers its webhook automatically. Viber bot approval and any provider fees remain with Viber.",
  messenger:
    "Use a Meta app with Messenger enabled, a Facebook Page access token and app secret. After Connect, enter the callback URL and verify token in Meta's Messenger webhook settings. Subscribe to messages. Production customers require the applicable Meta app review and permissions.",
  teams:
    "Use a registered Azure Bot with the Microsoft Teams channel enabled. Paste its app ID, client secret and tenant ID for a single-tenant bot. Set the bot Messaging endpoint to the callback URL below. Install your Teams app with the bot ID and personal scope. Tenant app approval is controlled by Microsoft Teams.",
};
export function MessagingChannels({
  workspaceId,
  canManage,
  deployments,
}: {
  workspaceId: string;
  canManage: boolean;
  deployments: { id: string; name: string; enabled: boolean }[];
}) {
  const base = `/workspaces/${workspaceId}/messaging-channels`,
    cache = useQueryClient(),
    [editing, setEditing] = useState<Channel | null>(null),
    [provider, setProvider] = useState<MessagingProvider>("telegram"),
    [name, setName] = useState(""),
    [deploymentId, setDeploymentId] = useState(""),
    [credentials, setCredentials] = useState<Record<string, string>>({}),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [verification, setVerification] = useState<{
      callbackUrl?: string;
      verifyToken?: string;
    } | null>(null),
    [delivery, setDelivery] = useState<
      {
        id: string;
        status: string;
        error_code: string | null;
        attempts: number;
        created_at: string;
      }[]
    >([]),
    [deliveryChannel, setDeliveryChannel] = useState("");
  const channels = useQuery({
    queryKey: ["messaging-channels", workspaceId],
    queryFn: () => requestJson<Channel[]>(base),
    refetchInterval: 10000,
  });
  async function perform(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
      await cache.invalidateQueries({
        queryKey: ["messaging-channels", workspaceId],
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel">
      <div className="panel-header">
        <div>
          <h3>Customer messaging</h3>
          <p>
            Connect a published agent to Messenger, Viber, Telegram or Teams.
            Replies and human support use the same conversation.
          </p>
        </div>
      </div>
      <div className="studio-form">
        {(error || channels.error) && (
          <p role="alert" className="error">
            {error || channels.error?.message}
          </p>
        )}
        {!channels.data?.length && (
          <p>
            No messaging channels connected. Add credentials below to get
            started.
          </p>
        )}
        {channels.data?.map((c) => (
          <details key={c.id} className="configure-group">
            <summary>
              {c.name} · {c.provider} ·{" "}
              {c.enabled
                ? c.last_received_at
                  ? "Receiving messages"
                  : c.settings.webhookRegistered
                    ? "Connected — send a test message"
                    : "Credentials verified — complete provider setup"
                : "Disconnected"}
            </summary>
            <p>{instructions[c.provider]}</p>
            {c.callbackUrl ? (
              <label>
                Callback URL
                <input readOnly value={c.callbackUrl} />
              </label>
            ) : (
              <p role="status">
                Set MESSAGING_PUBLIC_URL to your public HTTPS API origin and
                restart the API.
              </p>
            )}
            <p>Provider identity: {c.settings.identity || "Not verified"}</p>
            {c.last_error && <p role="alert">{c.last_error}</p>}
            <div className="actions">
              {canManage && (
                <>
                  <Button
                    disabled={busy}
                    onClick={() =>
                      perform(async () => {
                        setVerification(
                          await requestJson(
                            base + "/" + c.id + "/connect",
                            "POST",
                            {},
                          ),
                        );
                      })
                    }
                  >
                    Connect / test credentials
                  </Button>
                  <Button
                    className="secondary"
                    disabled={busy}
                    onClick={() =>
                      perform(async () => {
                        await requestJson(
                          base + "/" + c.id + "/disconnect",
                          "POST",
                          {},
                        );
                      })
                    }
                  >
                    Disconnect
                  </Button>
                  <Button
                    className="secondary"
                    onClick={() => {
                      setEditing(c);
                      setProvider(c.provider);
                      setName(c.name);
                      setDeploymentId(c.deployment_id);
                      setCredentials({});
                      setVerification(null);
                    }}
                  >
                    Edit credentials
                  </Button>
                </>
              )}
              <Button
                className="secondary"
                disabled={busy}
                onClick={() =>
                  perform(async () => {
                    setDelivery(
                      await requestJson(base + "/" + c.id + "/delivery"),
                    );
                    setDeliveryChannel(c.id);
                  })
                }
              >
                Delivery status
              </Button>
            </div>
            {deliveryChannel === c.id && (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Received</th>
                      <th>Status</th>
                      <th>Attempts</th>
                      <th>Error</th>
                    </tr>
                  </thead>
                  <tbody>
                    {delivery.map((d) => (
                      <tr key={d.id}>
                        <td>{new Date(d.created_at).toLocaleString()}</td>
                        <td>{d.status}</td>
                        <td>{d.attempts}</td>
                        <td>{d.error_code || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </details>
        ))}
        {verification && (
          <div className="success-banner" role="status">
            Credentials verified.{" "}
            {verification.callbackUrl && (
              <label>
                Callback URL
                <input readOnly value={verification.callbackUrl} />
              </label>
            )}
            {verification.verifyToken && (
              <label>
                Meta verify token
                <input readOnly value={verification.verifyToken} />
                <small>
                  Paste this token in Meta's webhook setup. It verifies setup;
                  your Page token stays encrypted.
                </small>
              </label>
            )}
          </div>
        )}
        {canManage && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void perform(async () => {
                const body = {
                  name,
                  provider,
                  deploymentId,
                  credentials: Object.fromEntries(
                    Object.entries(credentials).filter(([, v]) => v.trim()),
                  ),
                };
                const d = await requestJson<{
                  id: string;
                  callbackUrl: string;
                  verifyToken?: string;
                }>(
                  editing ? base + "/" + editing.id : base,
                  editing ? "PUT" : "POST",
                  body,
                );
                setCredentials({});
                setVerification(d);
                setEditing(null);
                setName("");
              });
            }}
            className="configure-group"
          >
            <h4>
              {editing ? "Edit channel credentials" : "Add messaging channel"}
            </h4>
            <label>
              Channel name
              <input
                required
                maxLength={100}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label>
              Provider
              <select
                aria-label="Provider"
                value={provider}
                disabled={!!editing}
                onChange={(e) => {
                  setProvider(e.target.value as MessagingProvider);
                  setCredentials({});
                }}
              >
                {(["messenger", "viber", "telegram", "teams"] as const).map(
                  (p) => (
                    <option key={p}>{p}</option>
                  ),
                )}
              </select>
            </label>
            <p>{instructions[provider]}</p>
            <label>
              Published deployment
              <select
                aria-label="Published deployment"
                required
                disabled={!!editing}
                value={deploymentId}
                onChange={(e) => setDeploymentId(e.target.value)}
              >
                <option value="">Choose a deployment</option>
                {deployments
                  .filter((d) => d.enabled)
                  .map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
              </select>
            </label>
            {messagingCredentialFields[provider].map((f) => (
              <label key={f.key}>
                {f.label}
                <input
                  type={f.secret ? "password" : "text"}
                  autoComplete="off"
                  required={!editing && f.required}
                  value={credentials[f.key] || ""}
                  onChange={(e) =>
                    setCredentials({ ...credentials, [f.key]: e.target.value })
                  }
                />
                {editing && (
                  <small>
                    Leave blank to keep the saved value. Saving disconnects the
                    channel; reconnect to verify it.
                  </small>
                )}
              </label>
            ))}
            <Button disabled={busy}>{busy ? "Saving…" : "Save channel"}</Button>
            {editing && (
              <Button
                type="button"
                className="secondary"
                onClick={() => {
                  setEditing(null);
                  setCredentials({});
                  setName("");
                }}
              >
                Cancel edit
              </Button>
            )}
            <p className="muted">
              Credentials stay encrypted on the server and are never returned.
              Customer chats are private/direct messages. Customers can send
              /rating 1–5 and /resolved yes or no. Existing provider permissions
              and messaging windows still apply.
            </p>
          </form>
        )}
      </div>
    </section>
  );
}
