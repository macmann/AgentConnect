"use client";
import { useCallback, useEffect, useState } from "react";
import { apiBase } from "./agent-client";
import { watchSupportLive } from "./support-live";

export type SupportEvent = {
  id: string;
  kind: string;
  content: string;
  created_at: string;
  actor_name?: string | null;
};
export type ConversationSupport = {
  status: string;
  conversationMode: string;
  access: {
    entryMode: string;
    canRequest: boolean;
    offer: { id: string; reason_code: string } | null;
    businessHours?: { open: boolean; message: string; timezone: string } | null;
  };
  events: SupportEvent[];
};
export function supportEventText(event: SupportEvent) {
  const operator = event.actor_name || "A support specialist";
  if (event.kind === "claimed") return `${operator} joined the chat.`;
  if (event.kind === "requested")
    return "Human support requested. Waiting for a specialist; you can keep sending messages here.";
  if (event.kind === "resolved")
    return `${operator} left the chat. The support request is resolved.`;
  if (event.kind === "ai_resumed")
    return "The AI agent has taken over and can continue helping in this chat.";
  return event.content;
}
export function useConversationSupport(
  endpoint: string | null,
  guestToken?: string,
  busy = false,
) {
  const [snapshot, setSnapshot] = useState<{
    endpoint: string;
    state: ConversationSupport;
  } | null>(null);
  const state = snapshot?.endpoint === endpoint ? snapshot.state : null;
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      if (!endpoint) return;
      const response = await fetch(apiBase + endpoint, {
        credentials: guestToken ? "omit" : "include",
        headers: guestToken ? { authorization: `Bearer ${guestToken}` } : {},
        signal,
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Support unavailable");
      if (!signal?.aborted) {
        setSnapshot({ endpoint, state: data });
        setError("");
      }
      return data as ConversationSupport;
    },
    [endpoint, guestToken],
  );
  useEffect(() => {
    setSnapshot(null);
    setError("");
    if (!endpoint) return;
    const controller = new AbortController();
    const update = () =>
      void refresh(controller.signal).catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    update();
    const timer = setInterval(update, 5000);
    const stop = watchSupportLive(endpoint + "/stream", update, guestToken);
    return () => {
      controller.abort();
      clearInterval(timer);
      stop();
    };
  }, [endpoint, guestToken, refresh]);
  useEffect(() => {
    const controller = new AbortController();
    if (!busy && endpoint) void refresh(controller.signal).catch(() => {});
    return () => controller.abort();
  }, [busy, endpoint, refresh]);
  async function post(action: "request" | "dismiss" | "message", content = "") {
    if (!endpoint) throw new Error("Start a conversation first");
    setSending(true);
    setError("");
    try {
      const response = await fetch(apiBase + endpoint, {
        method: "POST",
        credentials: guestToken ? "omit" : "include",
        headers: {
          "content-type": "application/json",
          ...(guestToken ? { authorization: `Bearer ${guestToken}` } : {}),
        },
        body: JSON.stringify({ action, content }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Support unavailable");
      return await refresh();
    } catch (e) {
      setError((e as Error).message);
      throw e;
    } finally {
      setSending(false);
    }
  }
  return { state, error, sending, refresh, post };
}
