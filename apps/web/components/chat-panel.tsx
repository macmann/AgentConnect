"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowUp, Square, RefreshCw, Sparkles } from "lucide-react";
import { Button } from "./button";
import { Citations, type Citation } from "./citations";
import { ToolTraces, type ToolTrace } from "./tool-studio";
import { streamChat } from "./agent-client";
export function ChatPanel({
  endpoint,
  name,
  welcomeMessage,
  starters = [],
}: {
  endpoint: string;
  name: string;
  welcomeMessage: string;
  starters?: string[];
}) {
  const [messages, setMessages] = useState<
    {
      role: "user" | "assistant";
      content: string;
      citations?: Citation[];
      tools?: ToolTrace[];
    }[]
  >([]);
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
    if (!text.trim() || busy) return;
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
          if (event === "done")
            setMessages((m) =>
              m.map((item, i) =>
                i === m.length - 1
                  ? { ...item, citations: data.citations ?? [] }
                  : item,
              ),
            );
          if (event === "error")
            setError(data.message ?? "The model request failed.");
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
              {m.content || (busy ? "Thinking…" : "No response content.")}
            </div>
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
          disabled={busy}
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
            disabled={!input.trim()}
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
