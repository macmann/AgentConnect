"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { QuickAction } from "@agentconnect/schemas/bank-experience";
import { ArrowUp, Square, RefreshCw, Sparkles } from "lucide-react";
import { ChatMarkdown } from "./chat-markdown";
import { AnswerReport } from "./answer-report";
import { CustomerFeedback } from "./customer-feedback";
import { CustomerWorkflow } from "./customer-workflow";
import { GenerativeResponse } from "./generative-response";
import type { RenderedBlock } from "@agentconnect/schemas/generative";
import { Button } from "./button";
import { Citations, type Citation } from "./citations";
import { ToolTraces, type ToolTrace } from "./tool-studio";
import { VoiceControls } from "./voice-controls";
import {
  useConversationSupport,
  supportEventText,
} from "./use-conversation-support";
import {
  openCustomerSession,
  customerRequest,
  writeMemory,
  type CustomerMemory,
} from "./customer-session";
import { streamChat, requestJson, apiBase } from "./agent-client";
function diagnosticHint(code: string): string {
  switch (code) {
    case "PROVIDER_HTTP_ERROR":
      return "Check the model identifier, account access, output token limit and supported sampling parameters.";
    case "AUTHENTICATION_FAILED":
      return "Check the selected workspace credential.";
    case "RATE_LIMITED":
      return "Check provider quota and retry later.";
    case "INCOMPLETE_STREAM":
      return "The provider ended its response unexpectedly. Retry or check provider availability.";
    case "ENDPOINT_NOT_ALLOWED":
      return "Approve the model hostname in the API settings.";
    default:
      return "";
  }
}
export function ChatPanel({
  endpoint,
  name,
  welcomeMessage,
  starters = [],
  quickActions = [],
  diagnostics = false,
}: {
  endpoint: string;
  name: string;
  welcomeMessage: string;
  starters?: string[];
  quickActions?: QuickAction[];
  diagnostics?: boolean;
}) {
  const [messages, setMessages] = useState<
    {
      role: "user" | "assistant";
      content: string;
      actionsEnabled?: boolean;
      messageId?: string;
      created_at?: string;
      blocks?: RenderedBlock[];
      citations?: Citation[];
      tools?: ToolTrace[];
    }[]
  >([]);
  const [workflowAction, setWorkflowAction] = useState<QuickAction | null>(
    null,
  );
  const customer = useRef<CustomerMemory | null>(null);
  const [restoring, setRestoring] = useState(true);
  const [handoffRequested, setHandoffRequested] = useState(false);
  const playgroundStorage = useRef<string | null>(null);
  const [conversationId, setConversationId] = useState<string | undefined>();
  const [olderMessages, setOlderMessages] = useState(false);
  const [history, setHistory] = useState<
    { id: string; title: string; created_at: string; handoff_status: string }[]
  >([]);
  const publicBase = endpoint.startsWith("/public/")
    ? endpoint.replace(/\/chat$/, "")
    : null;
  const composer = useRef<HTMLTextAreaElement | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [traceId, setTraceId] = useState("");
  const [contextPreview, setContextPreview] = useState<unknown>(null);
  const conversation = useRef<string | undefined>(undefined);
  const guest = useRef<string | undefined>(undefined);
  const controller = useRef<AbortController | null>(null);
  const bottom = useRef<HTMLDivElement | null>(null);
  const support = useConversationSupport(
    conversationId
      ? publicBase
        ? `${publicBase}/conversations/${conversationId}/handoff`
        : `/conversations/${conversationId}/handoff`
      : null,
    guest.current,
    busy,
  );
  const handoffOpen =
    handoffRequested ||
    ["pending", "active"].includes(support.state?.status ?? "");
  useEffect(() => {
    if (
      support.state?.status === "resolved" &&
      support.state?.conversationMode === "ai"
    )
      setHandoffRequested(false);
  }, [support.state]);
  const supportLoading = !!conversationId && !support.state && !support.error;
  const supportPaused = support.state?.conversationMode === "returning_to_ai";
  const transcript = [
    ...messages.map((m, index) => ({
      ...m,
      key: m.messageId ?? `ai-${index}`,
      label: m.role === "user" ? "You" : name,
      system: false,
    })),
    ...(support.state?.events ?? []).map((event) => ({
      blocks: undefined,
      messageId: undefined,
      actionsEnabled: false,
      citations: undefined,
      tools: undefined,
      key: event.id,
      role:
        event.kind === "user_message"
          ? ("user" as const)
          : ("assistant" as const),
      content: supportEventText(event),
      created_at: event.created_at,
      label:
        event.kind === "operator_message"
          ? event.actor_name || "Support specialist"
          : event.kind === "user_message"
            ? "You"
            : "Conversation",
      system: !["user_message", "operator_message"].includes(event.kind),
    })),
  ].sort(
    (a, b) =>
      (a.created_at ? Date.parse(a.created_at) : Number.MAX_SAFE_INTEGER) -
      (b.created_at ? Date.parse(b.created_at) : Number.MAX_SAFE_INTEGER),
  );
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "nearest" });
  }, [messages, support.state?.events.at(-1)?.id]);
  async function loadHistory(memory: CustomerMemory) {
    if (!publicBase) return;
    setHistory(await customerRequest(publicBase, memory, "/history"));
  }
  async function resume(id: string, memory: CustomerMemory) {
    if (!publicBase || busy) return;
    const saved = await customerRequest<{
      messages: typeof messages;
      hasMore?: boolean;
    }>(publicBase, memory, "/history/" + id);
    controller.current?.abort();
    conversation.current = id;
    setConversationId(id);
    setHandoffRequested(false);
    guest.current = memory.token;
    customer.current = { ...memory, active: id };
    writeMemory(publicBase, customer.current);
    setMessages(saved.messages);
    setOlderMessages(saved.hasMore ?? false);
    setError("");
    setTraceId("");
  }
  useEffect(() => {
    if (!publicBase) return;
    let active = true;
    setRestoring(true);
    openCustomerSession(publicBase)
      .then(async (memory) => {
        if (!active) return;
        customer.current = memory;
        await loadHistory(memory);
        if (memory.active && active) {
          try {
            await resume(memory.active, memory);
          } catch {
            if (active) {
              customer.current = { ...memory, active: undefined };
              writeMemory(publicBase, customer.current);
              setError(
                "The previous conversation is no longer available. You can start a new chat.",
              );
            }
          }
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setRestoring(false);
      });
    return () => {
      active = false;
    };
    // Session restores only when the deployment changes.
  }, [publicBase]);
  useEffect(() => {
    if (publicBase) return;
    let active = true;
    setRestoring(true);
    void (async () => {
      try {
        const user = await requestJson<{ id: string }>("/auth/me");
        if (!active) return;
        const key = `agentconnex:playground:${apiBase}:${user.id}:${endpoint}`;
        playgroundStorage.current = key;
        let id: string | null = null;
        try {
          id = localStorage.getItem(key);
        } catch {
          /* Storage is optional. */
        }
        if (id) {
          const saved = await requestJson<{ messages: typeof messages }>(
            endpoint.replace(/\/chat$/, `/conversations/${id}`),
          );
          if (!active) return;
          conversation.current = id;
          setConversationId(id);
          setMessages(saved.messages);
        }
      } catch (e) {
        if (active)
          setError(
            `Unable to restore Playground: ${(e as Error).message}. Use New chat to start again.`,
          );
      } finally {
        if (active) setRestoring(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [endpoint, publicBase]);
  async function send(text: string, quickActionId?: string) {
    if (
      !text.trim() ||
      busy ||
      support.sending ||
      supportPaused ||
      supportLoading ||
      restoring
    )
      return;
    if (handoffOpen) {
      setError("");
      try {
        await support.post("message", text);
        setInput("");
      } catch (e) {
        setError((e as Error).message);
      }
      return;
    }
    setBusy(true);
    setError("");
    setInput("");
    const abort = new AbortController();
    controller.current = abort;
    setMessages((m) => [
      ...m,
      { role: "user", content: text, created_at: new Date().toISOString() },
      { role: "assistant", content: "", created_at: new Date().toISOString() },
    ]);
    try {
      await streamChat(
        endpoint,
        {
          message: text,
          conversationId: conversation.current,
          ...(quickActionId ? { quickActionId } : {}),
        },
        abort.signal,
        (event, data) => {
          if (event === "meta") {
            conversation.current = data.conversationId;
            setConversationId(data.conversationId);
            if (playgroundStorage.current && data.conversationId) {
              try {
                localStorage.setItem(
                  playgroundStorage.current,
                  data.conversationId,
                );
              } catch {
                /* Storage is optional. */
              }
            }
            guest.current = data.guestToken ?? guest.current;
            setTraceId(data.traceId ?? "");
            if (publicBase && customer.current) {
              customer.current = {
                ...customer.current,
                active: data.conversationId,
              };
              writeMemory(publicBase, customer.current);
            }
          }
          if (event === "support") setHandoffRequested(true);
          if (event === "tool")
            setMessages((m) =>
              m.map((item, i) =>
                i === m.length - 1
                  ? {
                      ...item,
                      tools: [
                        ...(item.tools ?? []).filter(
                          (t) =>
                            t.toolId !== data.toolId || t.status !== "running",
                        ),
                        { ...data, status: data.status ?? "running" },
                      ],
                    }
                  : item,
              ),
            );
          if (event === "token")
            setMessages((m) =>
              m.map((item, i) =>
                i === m.length - 1
                  ? { ...item, content: item.content + (data.text ?? "") }
                  : item,
              ),
            );
          if (event === "ui")
            setMessages((m) =>
              m.map((item, i) =>
                i === m.length - 1
                  ? {
                      ...item,
                      content: data.message ?? "",
                      messageId: data.messageId,
                      blocks: data.blocks ?? [],
                      actionsEnabled: data.actionsEnabled,
                    }
                  : item,
              ),
            );
          if (event === "done")
            setMessages((m) =>
              m.map((item, i) =>
                i === m.length - 1
                  ? {
                      ...item,
                      messageId: data.messageId ?? item.messageId,
                      citations: data.citations ?? [],
                    }
                  : item,
              ),
            );
          if (event === "error")
            setError(
              diagnostics && data.code
                ? `${data.code}: ${data.message ?? "The model request failed."} ${diagnosticHint(data.code)}`
                : (data.message ?? "The model request failed."),
            );
        },
        guest.current,
        customer.current?.token,
      );
    } catch (e) {
      setError(
        abort.signal.aborted ? "Response cancelled." : (e as Error).message,
      );
    } finally {
      setBusy(false);
      controller.current = null;
      if (customer.current) void loadHistory(customer.current).catch(() => {});
    }
  }
  function submit(e: FormEvent) {
    e.preventDefault();
    void send(input);
  }
  function reset() {
    setWorkflowAction(null);
    controller.current?.abort();
    conversation.current = undefined;
    setConversationId(undefined);
    setHandoffRequested(false);
    if (playgroundStorage.current) {
      try {
        localStorage.removeItem(playgroundStorage.current);
      } catch {
        /* Storage is optional. */
      }
    }
    guest.current = undefined;
    if (publicBase && customer.current) {
      customer.current = { ...customer.current, active: undefined };
      writeMemory(publicBase, customer.current);
    }
    setMessages([]);
    setOlderMessages(false);
    setError("");
    setTraceId("");
  }
  return (
    <section
      className={`panel chat-panel${diagnostics ? " playground-chat" : ""}`}
    >
      <div className="panel-header">
        <div>
          <h3>
            <Sparkles size={17} />
            {diagnostics ? "Conversation" : name}
          </h3>
          {!diagnostics && (
            <p>
              {endpoint.startsWith("/public")
                ? "Published agent · hosted chat"
                : "Test your saved draft"}
            </p>
          )}
        </div>
        <button
          className="text-button"
          disabled={busy || support.sending || restoring}
          onClick={reset}
        >
          <RefreshCw size={14} />
          New chat
        </button>
      </div>
      {publicBase && (
        <details className="customer-history">
          <summary>Previous conversations ({history.length})</summary>
          <p className="muted">
            Saved on this browser for up to 30 days. Anyone using this browser
            can reopen these chats.
          </p>
          {restoring && <p role="status">Restoring conversation…</p>}
          {history.map((item) => (
            <button
              key={item.id}
              className="text-button"
              disabled={busy || restoring}
              onClick={() =>
                customer.current &&
                void resume(item.id, customer.current).catch((e) =>
                  setError(e.message),
                )
              }
            >
              {item.title || "Conversation"} ·{" "}
              {new Date(item.created_at).toLocaleDateString()} ·{" "}
              {item.handoff_status}
            </button>
          ))}
          {history.length >= 30 && (
            <Button
              type="button"
              className="secondary"
              disabled={busy || restoring}
              onClick={async () => {
                if (!customer.current) return;
                const last = history.at(-1)!;
                setRestoring(true);
                try {
                  const q = new URLSearchParams({
                    before: last.created_at,
                    beforeId: last.id,
                  });
                  const older = await customerRequest<typeof history>(
                    publicBase,
                    customer.current,
                    "/history?" + q,
                  );
                  setHistory((h) => [
                    ...h,
                    ...older.filter((o) => !h.some((i) => i.id === o.id)),
                  ]);
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setRestoring(false);
                }
              }}
            >
              Load older conversations
            </Button>
          )}
          <Button
            type="button"
            className="secondary"
            disabled={busy || restoring}
            onClick={async () => {
              if (!customer.current) return;
              try {
                await customerRequest(
                  publicBase,
                  customer.current,
                  "/sessions",
                  "DELETE",
                );
                writeMemory(publicBase, null);
                reset();
                customer.current = null;
                setHistory([]);
                setRestoring(true);
                customer.current = await openCustomerSession(publicBase);
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setRestoring(false);
              }
            }}
          >
            Forget this browser session
          </Button>
        </details>
      )}
      {!!quickActions.length && (
        <div className="quick-action-list" aria-label="Quick actions">
          {quickActions.map((a) => (
            <Button
              key={a.id}
              className="secondary"
              disabled={
                busy ||
                support.sending ||
                supportPaused ||
                supportLoading ||
                restoring
              }
              onClick={() => {
                if (a.behavior === "workflow" && publicBase) {
                  void (async () => {
                    setBusy(true);
                    try {
                      if (!conversation.current) {
                        const r = await fetch(
                          apiBase + publicBase + "/conversations",
                          {
                            method: "POST",
                            headers: {
                              authorization:
                                "Bearer " + customer.current!.token,
                            },
                          },
                        );
                        const data = await r.json();
                        if (!r.ok) throw new Error(data.error);
                        conversation.current = data.conversationId;
                        setConversationId(data.conversationId);
                        if (playgroundStorage.current) {
                          try {
                            localStorage.setItem(
                              playgroundStorage.current,
                              data.conversationId,
                            );
                          } catch {
                            /* Storage is optional. */
                          }
                        }
                        guest.current = customer.current!.token;
                        customer.current = {
                          ...customer.current!,
                          active: data.conversationId,
                        };
                        writeMemory(publicBase, customer.current);
                      }
                      setWorkflowAction(a);
                    } catch (e) {
                      setError((e as Error).message);
                    } finally {
                      setBusy(false);
                    }
                  })();
                } else if (a.behavior === "populate") {
                  setInput(a.message);
                  composer.current?.focus();
                } else void send(a.message, a.id);
              }}
            >
              {a.label}
            </Button>
          ))}
        </div>
      )}
      {publicBase && conversation.current && guest.current && (
        <CustomerWorkflow
          key={"workflow:" + conversation.current}
          base={publicBase}
          conversationId={conversation.current}
          token={guest.current}
          action={workflowAction}
          onClose={() => setWorkflowAction(null)}
        />
      )}
      {workflowAction && !conversation.current && (
        <p role="status">
          Send a message to start this conversation, then select the workflow
          action.
        </p>
      )}
      {restoring && <p role="status">Restoring conversation…</p>}
      <div
        className="chat-messages"
        role="log"
        aria-label="Conversation"
        aria-live="polite"
      >
        {olderMessages && publicBase && (
          <Button
            type="button"
            className="secondary"
            disabled={busy || restoring}
            onClick={async () => {
              if (
                !customer.current ||
                !conversation.current ||
                !messages[0]?.created_at ||
                !messages[0]?.messageId
              )
                return;
              setRestoring(true);
              try {
                const q = new URLSearchParams({
                  before: messages[0].created_at,
                  beforeId: messages[0].messageId,
                });
                const older = await customerRequest<{
                  messages: typeof messages;
                  hasMore: boolean;
                }>(
                  publicBase,
                  customer.current,
                  "/history/" + conversation.current + "?" + q,
                );
                setMessages((m) => [...older.messages, ...m]);
                setOlderMessages(older.hasMore);
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setRestoring(false);
              }
            }}
          >
            Load older messages
          </Button>
        )}
        {!messages.length && (
          <div className="chat-welcome">
            <Sparkles size={30} />
            <h3>{welcomeMessage}</h3>
            <p>Messages are saved in the workspace conversation history.</p>
            <div className="starters">
              {starters.map((s) => (
                <Button key={s} className="secondary" onClick={() => send(s)}>
                  {s}
                </Button>
              ))}
            </div>
          </div>
        )}
        {transcript.map((m) => (
          <div
            key={m.key}
            className={
              m.system ? "chat-system-event" : `chat-message ${m.role}`
            }
          >
            <small>{m.label}</small>
            {m.role === "assistant" && !m.system && m.content ? (
              <ChatMarkdown content={m.content} />
            ) : (
              <div>
                {m.content ||
                  (m.blocks?.length
                    ? null
                    : busy
                      ? "Thinking…"
                      : "No response content.")}
              </div>
            )}
            {m.blocks && m.messageId && (
              <GenerativeResponse
                blocks={m.blocks}
                messageId={m.messageId}
                guestToken={guest.current}
                interactive={m.actionsEnabled ?? true}
              />
            )}
            {m.citations && <Citations sources={m.citations} />}
            {m.tools && <ToolTraces traces={m.tools} />}
            {publicBase &&
              conversationId &&
              guest.current &&
              m.role === "assistant" &&
              !m.system &&
              m.messageId && (
                <AnswerReport
                  base={publicBase}
                  conversationId={conversationId}
                  messageId={m.messageId}
                  token={guest.current}
                  canRequestSupport={
                    !!support.state?.access.canRequestExplicit && !handoffOpen
                  }
                  onSupportRequested={() => setHandoffRequested(true)}
                />
              )}
          </div>
        ))}
        <div ref={bottom} />
      </div>
      {error && (
        <p className="error chat-error" role="alert">
          {error}
        </p>
      )}
      {diagnostics ? (
        <details className="playground-voice">
          <summary>Voice options</summary>
          <VoiceControls
            text={
              [...messages].reverse().find((m) => m.role === "assistant")
                ?.content ?? ""
            }
            onTranscript={setInput}
            disabled={
              busy ||
              support.sending ||
              supportPaused ||
              supportLoading ||
              restoring
            }
          />
        </details>
      ) : (
        <VoiceControls
          text={
            [...messages].reverse().find((m) => m.role === "assistant")
              ?.content ?? ""
          }
          onTranscript={setInput}
          disabled={
            busy ||
            support.sending ||
            supportPaused ||
            supportLoading ||
            restoring
          }
        />
      )}
      {support.state &&
        (support.state.access.canRequest ||
          support.state.access.offer ||
          handoffOpen ||
          supportPaused) && (
          <div className="chat-support-status" aria-label="Human support">
            {(handoffOpen ||
              supportPaused ||
              (support.state.access.businessHours &&
                !support.state.access.businessHours.open)) && (
              <p role="status">
                {handoffOpen
                  ? support.state.status !== "active"
                    ? "Waiting for a specialist. Messages here go to support."
                    : "You are chatting with human support."
                  : supportPaused
                    ? "AI chat is paused until support restores it."
                    : support.state.access.businessHours &&
                        !support.state.access.businessHours.open
                      ? support.state.access.businessHours.message
                      : null}
              </p>
            )}
            {support.state.access.canRequest && !handoffOpen && (
              <Button
                type="button"
                className="secondary"
                disabled={busy || support.sending}
                onClick={() => void support.post("request").catch(() => {})}
              >
                {support.state.access.offer
                  ? "Connect me"
                  : "Request human support"}
              </Button>
            )}
            {support.state.access.offer && !handoffOpen && (
              <Button
                type="button"
                className="secondary"
                disabled={busy || support.sending}
                onClick={() => void support.post("dismiss").catch(() => {})}
              >
                Keep trying with AI
              </Button>
            )}
          </div>
        )}
      {support.error && (
        <p className="error" role="alert">
          {support.error}
        </p>
      )}
      {publicBase &&
        conversation.current &&
        guest.current &&
        messages.some((m) => m.role === "assistant") && (
          <CustomerFeedback
            key={"feedback:" + conversation.current}
            base={publicBase}
            conversationId={conversation.current}
            token={guest.current}
          />
        )}
      <form onSubmit={submit} className="chat-composer">
        <label className="sr-only" htmlFor={`chat-${name}`}>
          Message
        </label>
        <textarea
          ref={composer}
          id={`chat-${name}`}
          aria-label="Message"
          placeholder={
            handoffOpen ? "Message human support…" : "Ask your agent…"
          }
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (
              e.key === "Enter" &&
              !e.shiftKey &&
              !e.nativeEvent.isComposing &&
              e.keyCode !== 229
            ) {
              e.preventDefault();
              if (
                !e.repeat &&
                !busy &&
                !support.sending &&
                !supportPaused &&
                !supportLoading &&
                !restoring &&
                input.trim()
              )
                e.currentTarget.form?.requestSubmit();
            }
          }}
          maxLength={handoffOpen ? 4000 : 12000}
          disabled={
            busy ||
            support.sending ||
            supportPaused ||
            supportLoading ||
            restoring
          }
        />
        {busy ? (
          <Button
            type="button"
            onClick={() => controller.current?.abort()}
            aria-label="Cancel response"
          >
            <Square size={15} />
          </Button>
        ) : (
          <Button
            type="submit"
            disabled={
              !input.trim() || support.sending || supportPaused || restoring
            }
            aria-label="Send message"
          >
            <ArrowUp size={17} />
          </Button>
        )}
      </form>
      {diagnostics && conversation.current && !busy && (
        <details>
          <summary>Debug / Advanced</summary>
          {traceId && <div className="chat-trace">Trace {traceId} · Saved</div>}
          <details>
            <summary>Token and context breakdown</summary>
            <Button
              type="button"
              className="secondary"
              onClick={() =>
                void requestJson(
                  `/conversations/${conversation.current}/context`,
                )
                  .then(setContextPreview)
                  .catch((e) => setError(e.message))
              }
            >
              Load run token counts
            </Button>
            {contextPreview !== null && (
              <pre>{JSON.stringify(contextPreview, null, 2)}</pre>
            )}
          </details>
        </details>
      )}
    </section>
  );
}
