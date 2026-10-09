"use client";
import { useEffect, useState } from "react";
import { Boxes } from "lucide-react";
import { ChatPanel } from "./chat-panel";
import { requestJson } from "./agent-client";
export function HostedChat({ deploymentId }: { deploymentId: string }) {
  const [deployment, setDeployment] = useState<{
    name: string;
    description: string;
    welcomeMessage: string;
    conversationStarters: string[];
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
    <main className="hosted-shell">
      <a className="brand" href="/">
        <Boxes />
        AgentConnect
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
          />
        </>
      ) : (
        <p className="empty">Loading published agent…</p>
      )}
      <p className="fine">
        Powered by AgentConnect · Conversations are saved by this agent’s
        workspace.
      </p>
    </main>
  );
}
