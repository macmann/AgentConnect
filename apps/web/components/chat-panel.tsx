"use client";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { ArrowUp, Square, RefreshCw, Sparkles } from "lucide-react";
import { GenerativeResponse } from "./generative-response";
import type { RenderedBlock } from "@agentconnect/schemas/generative";
import { Button } from "./button";
import { Citations, type Citation } from "./citations";
import { ToolTraces, type ToolTrace } from "./tool-studio";
import { VoiceControls } from "./voice-controls";
import { HandoffPanel } from "./handoff-panel";
import { streamChat } from "./agent-client";
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
  diagnostics = false,
}: {
  endpoint: string;
  name: string;
  welcomeMessage: string;
  starters?: string[];
  diagnostics?: boolean;
}) {
  const [messages, setMessages] = useState<
    {
      role: "user" | "assistant";
      content: string;
      actionsEnabled?: boolean;
      messageId?: string;
      blocks?: RenderedBlock[];
      citations?: Citation[];
      tools?: ToolTrace[];
    }[]
  >([]);
  const [handoffOpen, setHandoffOpen] = useState(false);
  const handoffStatus = useCallback(
    (open: boolean) => setHandoffOpen(open),
    [],
  );
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [traceId, setTraceId] = useState("");
  const conversation = useRef<string | undefined>(undefined);
  const guest = useRef<string | undefined>(undefined);
  const controller = useRef<AbortController | null>(null);
  const bottom = useRef<HTMLDivElement | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "nearest" });
  }, [messages]);
  async function send(text: string) {
    if (!text.trim() || busy || handoffOpen) return;
    setBusy(true);
    setError("");
    setInput("");
    const abort = new AbortController();
    controller.current = abort;
    setMessages((m) => [
      ...m,
      { role: "user", content: text },
      { role: "assistant", content: "" },
    ]);
    try {
      await streamChat(
        endpoint,
        { message: text, conversationId: conversation.current },
        abort.signal,
        (event, data) => {
          if (event === "meta") {
            conversation.current = data.conversationId;
            guest.current = data.guestToken ?? guest.current;
            setTraceId(data.traceId ?? "");
          }
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
                  ? { ...item, citations: data.citations ?? [] }
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
      );
    } catch (e) {
      setError(
        abort.signal.aborted ? "Response cancelled." : (e as Error).message,
      );
    } finally {
      setBusy(false);
      controller.current = null;
    }
  }
  function submit(e: FormEvent) {
    e.preventDefault();
    void send(input);
  }
  function reset() {
    controller.current?.abort();
    conversation.current = undefined;
    guest.current = undefined;
    setMessages([]);
    setError("");
    setTraceId("");
    setHandoffOpen(false);
  }
  return (
    <section className="panel chat-panel">
      <div className="panel-header">
        <div>
          <h3>
            <Sparkles size={17} />
            {name}
          </h3>
          <p>
            {endpoint.startsWith("/public")
              ? "Published agent · hosted chat"
              : "Draft playground · each new chat snapshots the saved draft"}
          </p>
        </div>
        <button className="text-button" disabled={busy} onClick={reset}>
          <RefreshCw size={14} />
          New chat
        </button>
      </div>
      <div className="chat-messages" aria-live="polite">
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
        {messages.map((m, i) => (
          <div key={i} className={`chat-message ${m.role}`}>
            <small>{m.role === "user" ? "You" : name}</small>
            <div>
              {m.content ||
                (m.blocks?.length
                  ? null
                  : busy
                    ? "Thinking…"
                    : "No response content.")}
            </div>
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
          </div>
        ))}
        <div ref={bottom} />
      </div>
      {error && (
        <p className="error chat-error" role="alert">
          {error}
        </p>
      )}
      <VoiceControls
        text={
          [...messages].reverse().find((m) => m.role === "assistant")
            ?.content ?? ""
        }
        onTranscript={setInput}
        disabled={busy || handoffOpen}
      />
      {conversation.current && (
        <HandoffPanel
          key={conversation.current}
          endpoint={
            endpoint.startsWith("/public")
              ? endpoint.replace(
                  /\/chat$/,
                  "/conversations/" + conversation.current + "/handoff",
                )
              : "/conversations/" + conversation.current + "/handoff"
          }
          guestToken={guest.current}
          busy={busy}
          onStatus={handoffStatus}
        />
      )}
      <form onSubmit={submit} className="chat-composer">
        <label className="sr-only" htmlFor={`chat-${name}`}>
          Message
        </label>
        <textarea
          id={`chat-${name}`}
          aria-label="Message"
          placeholder="Ask your agent…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          maxLength={12000}
          disabled={busy || handoffOpen}
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
            disabled={!input.trim() || handoffOpen}
            aria-label="Send message"
          >
            <ArrowUp size={17} />
          </Button>
        )}
      </form>
      {traceId && (
        <div className="chat-trace">
          Trace {traceId.slice(0, 12)} · {busy ? "Streaming" : "Saved"}
        </div>
      )}
    </section>
  );
}
