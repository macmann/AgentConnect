"use client";
import { useEffect, useState, type CSSProperties } from "react";
import { ChatPanel } from "./chat-panel";
import { requestJson } from "./agent-client";
import {
  customerAppearance,
  type CustomerAppearance,
} from "@agentconnect/schemas/customer-theme";
export function HostedChat({ deploymentId }: { deploymentId: string }) {
  const [deployment, setDeployment] = useState<{
    branding?: import("@agentconnect/schemas/customer-experience").Branding;
    appearance?: CustomerAppearance;
    name: string;
    description: string;
    welcomeMessage: string;
    conversationStarters: string[];
    quickActions?: import("@agentconnect/schemas/bank-experience").QuickAction[];
  } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    requestJson<typeof deployment>(`/public/deployments/${deploymentId}`)
      .then((d) => {
        if (active) {
          setDeployment(d);
          document.title = d?.name || "Chat";
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [deploymentId]);
  const a = deployment?.appearance ?? customerAppearance(deployment?.branding);
  return (
    <div
      className="customer-chat-page"
      style={
        {
          "--brand": a.primary,
          "--green": a.primary,
          "--focus": a.primary,
          "--primary": a.primary,
          "--accent": a.primary,
          "--accent-text": a.primary,
          "--on-accent": a.onPrimary,
          "--ink": a.text,
          "--muted": a.muted,
          "--line": a.line,
          "--paper": a.background,
          "--surface": a.background,
          "--surface-subtle": a.soft,
          "--accent-soft": a.soft,
          "--customer-on-primary": a.onPrimary,
          background: a.background,
          color: a.text,
          colorScheme: a.scheme,
        } as CSSProperties
      }
    >
      <main className="hosted-shell customer-chat-shell">
        {error ? (
          <div className="error-banner" role="alert">
            {error}
          </div>
        ) : deployment ? (
          <ChatPanel
            endpoint={`/public/deployments/${deploymentId}/chat`}
            name={deployment.name}
            welcomeMessage={deployment.welcomeMessage}
            starters={deployment.conversationStarters}
            quickActions={deployment.quickActions ?? []}
            customerView
            customerLogo={deployment.branding?.logoUrl}
          />
        ) : (
          <p className="empty" role="status">
            Loading chat…
          </p>
        )}
      </main>
    </div>
  );
}
