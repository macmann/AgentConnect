"use client";
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { AgentConfig } from "@agentconnect/schemas/agents";
import type { WorkflowGraph } from "@agentconnect/schemas/workflows";
import { requestJson } from "./agent-client";
import { Button } from "./button";
import { ChatMarkdown } from "./chat-markdown";
import { HelpTooltip } from "./help-tooltip";
import type { CreationSettings } from "./creation-assistant-settings";
type AgentProposal = {
  kind: "agent";
  name: string;
  description: string;
  publicDescription: string;
  config: AgentConfig;
};
type WorkflowProposal = {
  kind: "workflow";
  name: string;
  description: string;
  graph: WorkflowGraph;
};
type Proposal = AgentProposal | WorkflowProposal;
type Turn = { role: "user" | "assistant"; content: string };
type Reply = {
  message: string;
  suggestions: string[];
  draft: Proposal | null;
  summary: {
    model?: string;
    knowledge?: string[];
    tools?: string[];
    steps?: { label: string; agent: string; instructions: string }[];
  } | null;
};
export function CreationAssistant({
  workspaceId,
  kind,
  onManual,
  onCancel,
  onSettings,
  onAgent,
  onWorkflow,
}: {
  workspaceId: string;
  kind: "agent" | "workflow";
  onManual: () => void;
  onCancel: () => void;
  onSettings: () => void;
  onAgent?: (proposal: AgentProposal) => void;
  onWorkflow?: (proposal: WorkflowProposal) => Promise<void>;
}) {
  const settings = useQuery({
    queryKey: ["creation-settings", workspaceId],
    queryFn: () =>
      requestJson<CreationSettings>(
        `/workspaces/${workspaceId}/creation-settings`,
      ),
  });
  const [mode, setMode] = useState<"guided" | "assisted" | null>(null);
  const [messages, setMessages] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [reply, setReply] = useState<Reply | null>(null);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const transcript = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = transcript.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [messages, busy]);
  const ready = settings.data?.enabled && settings.data.available;
  async function send(text: string) {
    if (busy || !text.trim() || !mode || messages.length >= 15) return;
    const next: Turn[] = [...messages, { role: "user", content: text.trim() }];
    setMessages(next);
    setInput("");
    setError("");
    setBusy(true);
    setProposal(null);
    try {
      const result = await requestJson<Reply>(
        `/workspaces/${workspaceId}/creation-assistant`,
        "POST",
        { kind, mode, messages: next },
      );
      setMessages([...next, { role: "assistant", content: result.message }]);
      setReply(result);
      setProposal(result.draft);
    } catch (e) {
      setError((e as Error).message);
      setMessages(messages);
      setInput(text);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="creation-assistant" aria-labelledby="creation-heading">
      <header className="creation-header">
        <div>
          <h3 id="creation-heading">
            Create {kind === "agent" ? "an agent" : "a workflow"}
          </h3>
          <p>
            Choose the help you need. You can review every setting before using
            it.
          </p>
        </div>
        <Button className="secondary" disabled={busy} onClick={onCancel}>
          Cancel setup
        </Button>
      </header>
      {!mode ? (
        <>
          <div className="creation-mode-grid">
            <button
              className="creation-mode-card"
              disabled={!ready || settings.isPending}
              onClick={() => {
                setMode("guided");
                setMessages([
                  {
                    role: "assistant",
                    content:
                      kind === "agent"
                        ? "What should your agent help people do? Tell me who it will help and the problem it should solve."
                        : "What should your workflow achieve? Tell me the outcome you want and which published agents should work together.",
                  },
                ]);
              }}
            >
              <strong>AI guide</strong>
              <span>
                Answer one question at a time. Build a draft together.
              </span>
            </button>
            <button
              className="creation-mode-card"
              disabled={!ready || settings.isPending}
              onClick={() => {
                setMode("assisted");
                setMessages([
                  {
                    role: "assistant",
                    content:
                      "Describe what you want to build. Include its purpose, the people it helps, available knowledge or agents, and any boundaries. I’ll propose a draft for your review.",
                  },
                ]);
              }}
            >
              <strong>AI-assisted draft</strong>
              <span>
                Describe your idea and refine the proposed configuration.
              </span>
            </button>
            <button className="creation-mode-card" onClick={onManual}>
              <strong>Manual setup</strong>
              <span>
                {kind === "workflow"
                  ? "Use existing templates or start on a blank canvas."
                  : "Choose all settings yourself in Agent Configure."}
              </span>
            </button>
          </div>
          {settings.isPending ? (
            <p role="status">Checking assistant availability…</p>
          ) : (
            !ready && (
              <div className="settings-hint">
                <span>
                  {settings.error
                    ? "Unable to load assistant settings."
                    : "AI creation needs an assistant model. Manual setup is ready."}
                </span>
                <Button className="secondary" onClick={onSettings}>
                  Open Settings
                </Button>
                {settings.error && (
                  <Button
                    className="secondary"
                    onClick={() => void settings.refetch()}
                  >
                    Retry
                  </Button>
                )}
              </div>
            )
          )}
        </>
      ) : (
        <div className="creation-layout">
          <div className="creation-chat">
            <div className="creation-chat-heading">
              <strong>
                {mode === "guided" ? "Your AI guide" : "Draft assistant"}
              </strong>
              <HelpTooltip label="About the creation assistant">
                Uses{" "}
                {settings.data?.modelName || "your workspace assistant model"}.
                Messages and resource names go to this provider; no document
                contents or credentials are included. Do not enter secrets.
                Proposals are suggestions and must be reviewed.
              </HelpTooltip>
              <Button
                className="text-button"
                disabled={busy}
                onClick={() => {
                  setMode(null);
                  setMessages([]);
                  setReply(null);
                  setProposal(null);
                  setError("");
                }}
              >
                Start over
              </Button>
            </div>
            <div
              ref={transcript}
              className="creation-transcript"
              role="log"
              aria-label="Creation conversation"
              aria-live="polite"
            >
              {messages.map((message, index) => (
                <div key={index} className={`creation-turn ${message.role}`}>
                  <small>
                    {message.role === "user" ? "You" : "Creation assistant"}
                  </small>
                  <ChatMarkdown content={message.content} />
                </div>
              ))}
              {busy && <p role="status">Preparing your next step…</p>}
            </div>
            {error && (
              <p className="error-banner" role="alert">
                {error}
              </p>
            )}
            {!busy && reply?.suggestions && (
              <div className="creation-suggestions">
                {reply.suggestions.map((text) => (
                  <Button
                    className="secondary"
                    key={text}
                    disabled={messages.length >= 15}
                    onClick={() => void send(text)}
                  >
                    {text}
                  </Button>
                ))}
              </div>
            )}
            {messages.length >= 15 && (
              <p className="muted">
                Conversation limit reached. Review your draft or start over with
                a shorter description.
              </p>
            )}
            <form
              className="creation-composer"
              onSubmit={(event) => {
                event.preventDefault();
                void send(input);
              }}
            >
              <label className="sr-only" htmlFor="creation-message">
                Message to creation assistant
              </label>
              <textarea
                id="creation-message"
                value={input}
                onChange={(event) => setInput(event.target.value)}
                rows={3}
                maxLength={4000}
                disabled={busy || messages.length >= 15}
                placeholder={
                  mode === "guided"
                    ? "Tell me about your idea…"
                    : "Describe the agent or workflow you want…"
                }
                onKeyDown={(event) => {
                  if (
                    event.key === "Enter" &&
                    !event.shiftKey &&
                    !event.nativeEvent.isComposing
                  ) {
                    event.preventDefault();
                    void send(input);
                  }
                }}
              />
              <Button disabled={busy || !input.trim() || messages.length >= 15}>
                Send
              </Button>
            </form>
            {!proposal && messages.some((m) => m.role === "user") && (
              <Button
                className="text-button"
                disabled={busy || messages.length >= 15}
                onClick={() =>
                  void send(
                    "Generate a draft now using what we discussed. Explain any missing prerequisites.",
                  )
                }
              >
                Generate draft now
              </Button>
            )}
          </div>
          <aside className="creation-review" aria-label="Draft review">
            <h4>Review your draft</h4>
            {!proposal ? (
              <p className="muted">
                Your proposed settings will appear here. Nothing is saved or
                published during the conversation.
              </p>
            ) : (
              <>
                <label>
                  Name
                  <input
                    value={proposal.name}
                    maxLength={100}
                    onChange={(e) =>
                      setProposal({ ...proposal, name: e.target.value })
                    }
                  />
                </label>
                <label>
                  Description
                  <textarea
                    value={proposal.description}
                    maxLength={2000}
                    rows={2}
                    onChange={(e) =>
                      setProposal({ ...proposal, description: e.target.value })
                    }
                  />
                </label>
                {proposal.kind === "agent" ? (
                  <>
                    <dl>
                      <dt>Runtime model</dt>
                      <dd>{reply?.summary?.model}</dd>
                      <dt>Knowledge</dt>
                      <dd>
                        {reply?.summary?.knowledge?.join(", ") ||
                          "None attached"}
                      </dd>
                      <dt>Read-only tools</dt>
                      <dd>
                        {reply?.summary?.tools?.join(", ") || "None attached"}
                      </dd>
                    </dl>
                    <label>
                      Agent role
                      <textarea
                        value={proposal.config.prompt.role}
                        maxLength={4000}
                        rows={3}
                        onChange={(e) =>
                          setProposal({
                            ...proposal,
                            config: {
                              ...proposal.config,
                              prompt: {
                                ...proposal.config.prompt,
                                role: e.target.value,
                              },
                            },
                          })
                        }
                      />
                    </label>
                    <details>
                      <summary>View instructions and boundaries</summary>
                      <p>{proposal.config.prompt.objective}</p>
                      <p>{proposal.config.prompt.instructions}</p>
                      <p>{proposal.config.prompt.constraints}</p>
                    </details>
                    <p className="muted">
                      Continue to Configure to review all settings, save, test
                      and publish when ready.
                    </p>
                  </>
                ) : (
                  <>
                    <ol className="creation-step-list">
                      {reply?.summary?.steps?.map((step, index) => (
                        <li key={index}>
                          <strong>{step.label}</strong>
                          <span>{step.agent}</span>
                          <details>
                            <summary>Step instructions</summary>
                            <p>
                              {step.instructions ||
                                "Use the agent’s published instructions."}
                            </p>
                          </details>
                        </li>
                      ))}
                    </ol>
                    <p className="muted">
                      This creates a draft chain. Review mappings and test on
                      the canvas before publishing. Triggers and branching are
                      configured there.
                    </p>
                  </>
                )}
                <Button
                  disabled={busy || !proposal.name.trim()}
                  onClick={async () => {
                    setError("");
                    setBusy(true);
                    try {
                      if (proposal.kind === "agent") onAgent?.(proposal);
                      else await onWorkflow?.(proposal);
                    } catch (e) {
                      setError((e as Error).message);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  {proposal.kind === "agent"
                    ? "Use draft in Configure"
                    : "Create workflow draft"}
                </Button>
              </>
            )}
          </aside>
        </div>
      )}
    </section>
  );
}
