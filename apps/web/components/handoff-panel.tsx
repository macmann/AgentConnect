"use client";
import { useEffect, useState } from "react";
import { apiBase } from "./agent-client";
import { Button } from "./button";
export function HandoffPanel({
  endpoint,
  guestToken,
  busy,
  onStatus,
}: {
  endpoint: string;
  guestToken?: string;
  busy: boolean;
  onStatus: (open: boolean) => void;
}) {
  const [access, setAccess] = useState<{
    entryMode: string;
    canRequest: boolean;
    offer: { id: string; reason_code: string } | null;
  } | null>(null);
  const [mode, setMode] = useState("ai");
  const [status, setStatus] = useState("none"),
    [events, setEvents] = useState<
      { id: string; kind: string; content: string }[]
    >([]),
    [text, setText] = useState(""),
    [error, setError] = useState(""),
    [sending, setSending] = useState(false);
  useEffect(() => {
    let active = true;
    async function refresh() {
      try {
        const r = await fetch(apiBase + endpoint, {
            credentials: "include",
            headers: guestToken
              ? { authorization: `Bearer ${guestToken}` }
              : {},
          }),
          d = await r.json();
        if (!r.ok) throw new Error(d.error ?? "Support unavailable");
        if (active) {
          setAccess(d.access);
          setError("");
          setStatus(d.status);
          setMode(d.conversationMode ?? "ai");
          setEvents(d.events);
          onStatus(
            ["pending", "active"].includes(d.status) ||
              d.conversationMode === "returning_to_ai",
          );
        }
      } catch (e) {
        if (active) setError((e as Error).message);
      }
    }
    void refresh();
    const timer = setInterval(refresh, 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [endpoint, guestToken, onStatus, busy]);
  async function post(action: string) {
    setSending(true);
    setError("");
    try {
      const r = await fetch(apiBase + endpoint, {
          method: "POST",
          credentials: "include",
          headers: {
            "content-type": "application/json",
            ...(guestToken ? { authorization: `Bearer ${guestToken}` } : {}),
          },
          body: JSON.stringify({
            action,
            content: action === "message" ? text : "",
          }),
        }),
        d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "Support unavailable");
      if (action === "request") {
        setStatus("pending");
        onStatus(true);
      }
      if (action === "dismiss")
        setAccess((a) => (a ? { ...a, canRequest: false, offer: null } : a));
      setText("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  }
  const open = ["pending", "active"].includes(status);
  if (
    !open &&
    mode !== "returning_to_ai" &&
    access?.entryMode === "disabled" &&
    !error
  )
    return null;
  return (
    <section className="handoff-panel">
      <h4>Human support</h4>
      {events
        .filter((e) => ["user_message", "operator_message"].includes(e.kind))
        .map((e) => (
          <p key={e.id}>
            <strong>
              {e.kind === "operator_message" ? "Support" : "You"}:{" "}
            </strong>
            {e.content}
          </p>
        ))}
      {open ? (
        <>
          <p>
            {status === "pending"
              ? "Waiting for an operator. You can leave a message."
              : "An operator has joined. Messages below go to human support."}
          </p>
          <label>
            Message to support
            <textarea
              value={text}
              maxLength={4000}
              onChange={(e) => setText(e.target.value)}
            />
          </label>
          <Button
            type="button"
            disabled={!text.trim() || sending}
            onClick={() => void post("message")}
          >
            Send to support
          </Button>
        </>
      ) : (
        <>
          <p>
            {mode === "returning_to_ai"
              ? "Support resolved this request. AI chat is paused until support restores it."
              : status === "resolved"
                ? "Support resolved this request. You can chat with the agent again. The AI has the approved resolution and can continue helping."
                : access?.offer
                  ? "We haven’t been able to resolve this yet. Would you like to connect with a support specialist?"
                  : access?.canRequest
                    ? "A support specialist can help. Response time depends on workspace staffing."
                    : "You can ask the agent for a support specialist if you need more help."}
          </p>
          {access?.canRequest && (
            <Button
              type="button"
              className="secondary"
              disabled={busy || sending}
              onClick={() => void post("request")}
            >
              {access.offer ? "Connect me" : "Request human support"}
            </Button>
          )}
          {access?.offer && (
            <Button
              type="button"
              className="secondary"
              disabled={busy || sending}
              onClick={() => void post("dismiss")}
            >
              Keep trying with AI
            </Button>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </section>
  );
}
