"use client";
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { requestJson } from "./agent-client";
import { SettingsHint, SetupGuide } from "./settings-help";
import { Button } from "./button";
export function ConnectorSignIn({
  workspaceId,
  provider,
  secretId,
  onConnected,
}: {
  workspaceId: string;
  provider: string;
  secretId?: string;
  onConnected: (id: string) => void;
}) {
  const base = `/workspaces/${workspaceId}/connectors/oauth`,
    cache = useQueryClient();
  const [attempt, setAttempt] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState("");
  const popup = useRef<Window | null>(null);
  const providers = useQuery({
    queryKey: ["connector-oauth-providers", workspaceId],
    queryFn: () =>
      requestJson<{ provider: string; ready: boolean; redirectUri?: string }[]>(
        base + "/providers",
      ),
  });
  const status = useQuery({
    queryKey: ["connector-oauth-status", workspaceId, attempt],
    queryFn: () =>
      requestJson<{
        status: string;
        secret_id: string | null;
        error_code: string | null;
      }>(base + "/" + attempt),
    enabled: !!attempt,
    refetchInterval: 2000,
  });
  useEffect(() => {
    const result = status.data;
    if (result?.status === "connected" && result.secret_id) {
      onConnected(result.secret_id);
      setAttempt("");
      setNotice("Signed in. Select your source, then save and synchronize.");
      popup.current?.close();
      void cache.invalidateQueries({
        queryKey: ["connector-secrets", workspaceId],
      });
    } else if (result && ["failed", "expired"].includes(result.status)) {
      setAttempt("");
      setError(result.error_code ?? "Sign-in expired. Try again.");
      popup.current?.close();
    }
  }, [status.data, onConnected, cache, workspaceId]);
  const ready = providers.data?.find((p) => p.provider === provider)?.ready;
  const name =
    provider === "google-drive"
      ? "Google"
      : provider === "slack"
        ? "Slack"
        : "Microsoft";
  return (
    <section className="connector-sign-in" aria-label="Guided source sign-in">
      <h4>Connect your {name} account</h4>
      <SettingsHint label="Read-only access">
        Sign in with an account that can access your folder or channel.
        Credentials are encrypted on the server. Imported content uses the
        knowledge base’s audience.
      </SettingsHint>
      {providers.isPending ? (
        <p>Checking sign-in availability…</p>
      ) : !ready ? (
        <>
          <p className="muted">
            Sign-in isn’t configured. Select a credential below.
          </p>
          <SetupGuide title="Administrator sign-in setup">
            Configure the provider OAuth app and redirect URL in{" "}
            <a
              href="https://github.com/macmann/AgentConnect/blob/main/docs/connectors.md"
              target="_blank"
              rel="noreferrer"
            >
              the connector setup guide
            </a>
            . You can also use an existing workspace credential.
          </SetupGuide>
        </>
      ) : (
        <Button
          disabled={busy || !!attempt}
          onClick={() => {
            setError("");
            setNotice("");
            popup.current = window.open(
              "about:blank",
              "agentconnect-source-sign-in",
              "width=620,height=760",
            );
            if (!popup.current) {
              setError("Allow pop-ups for Agent Connex, then try again.");
              return;
            }
            setBusy(true);
            void requestJson<{ id: string; url: string }>(
              base + "/start",
              "POST",
              { provider, ...(secretId ? { secretId } : {}) },
            )
              .then((r) => {
                if (popup.current) popup.current.location.href = r.url;
                setAttempt(r.id);
              })
              .catch((e) => {
                popup.current?.close();
                setError(e instanceof Error ? e.message : "Sign-in failed");
              })
              .finally(() => setBusy(false));
          }}
        >
          {attempt
            ? "Waiting for sign-in…"
            : secretId
              ? `Reconnect with ${name}`
              : `Sign in with ${name}`}
        </Button>
      )}
      {attempt && (
        <Button
          onClick={() => {
            popup.current?.close();
            setAttempt("");
            setNotice("Sign-in closed. You can try again.");
          }}
        >
          Cancel sign-in
        </Button>
      )}
      {(error || status.error || providers.error) && (
        <p className="error" role="alert">
          {error || status.error?.message || providers.error?.message}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}
