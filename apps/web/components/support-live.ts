"use client";
import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { apiBase } from "./agent-client";
export function watchSupportLive(
  path: string,
  refresh: () => void,
  guestToken?: string,
) {
  const controller = new AbortController();
  let retry: ReturnType<typeof setTimeout> | undefined,
    pending: ReturnType<typeof setTimeout> | undefined;
  const update = () => {
    if (pending) return;
    pending = setTimeout(() => {
      pending = undefined;
      if (document.visibilityState === "visible") refresh();
    }, 1000);
  };
  async function connect() {
    try {
      const r = await fetch(apiBase + path, {
        credentials: "include",
        headers: guestToken ? { Authorization: "Bearer " + guestToken } : {},
        signal: controller.signal,
      });
      if (!r.ok || !r.body) throw new Error("Live updates unavailable");
      const reader = r.body.getReader(),
        decoder = new TextDecoder();
      let text = "";
      while (!controller.signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
        let i;
        while ((i = text.indexOf("\n\n")) >= 0) {
          const frame = text.slice(0, i);
          text = text.slice(i + 2);
          if (frame.startsWith("event: refresh")) update();
        }
      }
    } catch {
      /* Existing polling remains available during connection failures. */
    }
    if (!controller.signal.aborted)
      retry = setTimeout(() => void connect(), 2000);
  }
  void connect();
  return () => {
    controller.abort();
    if (retry) clearTimeout(retry);
    if (pending) clearTimeout(pending);
  };
}
export function useWorkspaceSupportLive(workspaceId: string, enabled: boolean) {
  const cache = useQueryClient();
  useEffect(() => {
    if (enabled)
      return watchSupportLive(
        `/workspaces/${workspaceId}/support/stream`,
        () => {
          void cache.invalidateQueries({
            queryKey: ["support", workspaceId],
            predicate: (query) =>
              [
                "cases",
                "case",
                "timeline",
                "summary",
                "notifications",
                "supervision",
                "profiles",
                "analytics",
              ].includes(String(query.queryKey[2])),
          });
        },
      );
  }, [cache, enabled, workspaceId]);
}
