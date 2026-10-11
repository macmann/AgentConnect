"use client";
import { useEffect, useState } from "react";
import { ProductBrand } from "./product-brand";
import { ChatPanel } from "./chat-panel";
import { requestJson } from "./agent-client";
export function HostedChat({ deploymentId }: { deploymentId: string }) {
  const [deployment, setDeployment] = useState<{
    branding?: import("@agentconnect/schemas/customer-experience").Branding;
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
        if (active) setDeployment(d);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [deploymentId]);
  return (
    <main
      className="hosted-shell"
      style={
        deployment?.branding
          ? ({
              "--brand": deployment.branding.primaryColor,
              "--accent": deployment.branding.primaryColor,
              background: deployment.branding.backgroundColor,
              color: deployment.branding.textColor,
            } as React.CSSProperties)
          : undefined
      }
    >
      <a className="brand" href="/">
        {deployment?.branding?.logoUrl ? (
          <img
            src={deployment.branding.logoUrl}
            alt={deployment.name + " logo"}
            width={36}
            height={36}
            referrerPolicy="no-referrer"
          />
        ) : (
          <ProductBrand />
        )}
        {deployment?.branding?.name || ""}
      </a>
      {error ? (
        <div className="error-banner" role="alert">
          {error}
        </div>
      ) : deployment ? (
        <>
          <h1>{deployment.name}</h1>
          <p className="muted">{deployment.description}</p>
          <ChatPanel
            endpoint={`/public/deployments/${deploymentId}/chat`}
            name={deployment.name}
            welcomeMessage={deployment.welcomeMessage}
            starters={deployment.conversationStarters}
            quickActions={deployment.quickActions ?? []}
          />
        </>
      ) : (
        <p className="empty">Loading published agent…</p>
      )}
      <p className="fine">
        Powered by Agent Connex · Conversations are saved by this agent’s
        workspace.
      </p>
    </main>
  );
}
