"use client";
import { useState } from "react";
import {
  branding,
  type Branding,
} from "@agentconnect/schemas/customer-experience";
import { requestJson } from "./agent-client";
import { Button } from "./button";
export function CustomerBranding({
  workspaceId,
  deploymentId,
  value,
  manage,
}: {
  workspaceId: string;
  deploymentId: string;
  value: unknown;
  manage: boolean;
}) {
  const [draft, setDraft] = useState<Branding>(() =>
      branding.parse(value ?? {}),
    ),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState("");
  const field = <K extends keyof Branding>(key: K, v: Branding[K]) =>
    setDraft((d) => ({ ...d, [key]: v }));
  return (
    <section className="configure-group">
      <h3>Customer branding</h3>
      <p className="muted">
        Shared by hosted chat and the website widget. Blank name or welcome uses
        the published agent settings.
      </p>
      <fieldset disabled={!manage || busy}>
        <label>
          Chatbot name
          <input
            maxLength={100}
            value={draft.name}
            onChange={(e) => field("name", e.target.value)}
          />
        </label>
        <label>
          Logo URL
          <input
            type="url"
            value={draft.logoUrl}
            onChange={(e) => field("logoUrl", e.target.value)}
            placeholder="https://example.com/logo.png"
          />
          <small>Public HTTPS image; use a logo you control.</small>
        </label>
        <label>
          Welcome message
          <textarea
            maxLength={1000}
            value={draft.welcomeMessage}
            onChange={(e) => field("welcomeMessage", e.target.value)}
          />
        </label>
        <div className="form-grid">
          {(["primaryColor", "backgroundColor", "textColor"] as const).map(
            (key) => (
              <label key={key}>
                {
                  {
                    primaryColor: "Button color",
                    backgroundColor: "Background color",
                    textColor: "Text color",
                  }[key]
                }
                <input
                  type="color"
                  value={draft[key]}
                  onChange={(e) => field(key, e.target.value)}
                />
              </label>
            ),
          )}
        </div>
        <div
          className="branding-preview"
          style={{
            background: draft.backgroundColor,
            color: draft.textColor,
            padding: 16,
            borderRadius: 8,
          }}
        >
          <strong>{draft.name || "Chatbot"}</strong>
          <p>{draft.welcomeMessage || "How can we help?"}</p>
          <span
            style={{
              display: "inline-block",
              padding: 8,
              background: draft.primaryColor,
              color: "#fff",
            }}
          >
            Chat preview
          </span>
        </div>
        <Button
          type="button"
          onClick={async () => {
            setNotice("");
            const parsed = branding.safeParse(draft);
            if (!parsed.success) {
              setNotice(parsed.error.issues.map((i) => i.message).join(" "));
              return;
            }
            setBusy(true);
            try {
              await requestJson(
                `/workspaces/${workspaceId}/channels/${deploymentId}/branding`,
                "PUT",
                parsed.data,
              );
              setNotice("Branding saved for hosted chat and widget.");
            } catch (e) {
              setNotice((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          Save branding
        </Button>
      </fieldset>
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}
