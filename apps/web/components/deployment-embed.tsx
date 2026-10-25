"use client";

import { useEffect, useState } from "react";
import { Button } from "./button";
import { apiBase } from "./agent-client";

/** Only public deployment identifiers belong in installation snippets. */
export function DeploymentEmbed({ deploymentId }: { deploymentId: string }) {
  const [origin, setOrigin] = useState("");
  const [copied, setCopied] = useState("");
  const [error, setError] = useState("");
  useEffect(() => setOrigin(window.location.origin), []);
  const escape = (value: string) =>
    value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  const url = `${origin}/chat/${deploymentId}`;
  const snippets = [
    {
      name: "Inline iframe",
      hint: "Place this where the chat should appear on your page.",
      code: `<iframe src="${escape(url)}" title="AI assistant" style="width:100%;height:720px;border:0;border-radius:12px" loading="lazy"></iframe>`,
    },
    {
      name: "Floating chat widget",
      hint: "Add before </body>. Enable the widget and approve your website origin in Channels first.",
      code: `<script async src="${escape(apiBase)}/widget.js" data-deployment="${escape(deploymentId)}" data-chat-url="${escape(url)}"></script>`,
    },
  ];
  return (
    <details className="deployment-embed">
      <summary>Embed on your website</summary>
      <div className="deployment-embed-body">
        {snippets.map(({ name, hint, code }) => (
          <div className="embed-snippet" key={name}>
            <div className="embed-snippet-heading">
              <strong>{name}</strong>
              <Button
                type="button"
                className="secondary"
                disabled={!origin}
                onClick={async () => {
                  setError("");
                  try {
                    await navigator.clipboard.writeText(code);
                    setCopied(name);
                  } catch {
                    setError(
                      "Copy unavailable. Select and copy the code below.",
                    );
                  }
                }}
              >
                Copy {name === "Inline iframe" ? "iframe" : "widget"} code
              </Button>
            </div>
            <p className="muted">{hint}</p>
            <textarea
              aria-label={`${name} embed code`}
              readOnly
              rows={3}
              value={origin ? code : "Loading embed URL…"}
              onFocus={(event) => event.currentTarget.select()}
            />
          </div>
        ))}
        {copied && <p role="status">{copied} code copied.</p>}
        {error && <p role="alert">{error}</p>}
        <small>
          These snippets grant access to the published chat. No API key is
          required.
        </small>
      </div>
    </details>
  );
}
