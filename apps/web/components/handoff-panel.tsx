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
          setStatus(d.status);
          setEvents(d.events);
          onStatus(["pending", "active"].includes(d.status));
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
  }, [endpoint, guestToken, onStatus]);
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
      setText("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  }
  const open = ["pending", "active"].includes(status);
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
            {status === "resolved"
              ? "Support resolved this request. You can chat with the agent again."
              : "Request an operator if you need help beyond the agent. Response time depends on workspace staffing."}
          </p>
          <Button
            type="button"
            className="secondary"
            disabled={busy || sending}
            onClick={() => void post("request")}
          >
            Request human support
          </Button>
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
