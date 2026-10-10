import type { RenderedBlock } from "@agentconnect/schemas/generative";
import type { Citation } from "./citations";
export const apiBase =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export async function requestJson<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(apiBase + path, {
      method,
      credentials: "include",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error(
      "Cannot reach the API. Check that the API service is running, then try again.",
    );
  }
  if (response.status === 204) return undefined as T;
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ApiError(
      typeof data?.error === "string"
        ? data.error
        : `Request failed (HTTP ${response.status}). Please try again.`,
      response.status,
    );
  }
  if (data === null)
    throw new Error(
      "The API returned an unexpected response. Please try again.",
    );
  return data as T;
}

export interface StreamData {
  actionsEnabled?: boolean;
  messageId?: string;
  blocks?: RenderedBlock[];
  error_code?: string;
  executionId?: string;
  toolId?: string;
  name?: string;
  durationMs?: number;
  result?: unknown;
  conversationId?: string;
  guestToken?: string;
  text?: string;
  message?: string;
  code?: string;
  status?: string;
  traceId?: string;
  citations?: Citation[];
  sources?: Citation[];
}
export async function streamChat(
  path: string,
  body: unknown,
  signal: AbortSignal,
  onEvent: (event: string, data: StreamData) => void,
  guestToken?: string,
) {
  const response = await fetch(apiBase + path, {
    method: "POST",
    credentials: "include",
    signal,
    headers: {
      "Content-Type": "application/json",
      ...(guestToken ? { Authorization: `Bearer ${guestToken}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error ?? "Chat request failed");
  }
  if (!response.body) throw new Error("Streaming is unavailable");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let split;
      while ((split = buffer.indexOf("\n\n")) >= 0) {
        const raw = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        const event = raw
          .split("\n")
          .find((s) => s.startsWith("event:"))
          ?.slice(6)
          .trim();
        const data = raw
          .split("\n")
          .find((s) => s.startsWith("data:"))
          ?.slice(5)
          .trim();
        if (event && data) {
          onEvent(event, JSON.parse(data) as StreamData);
          if (event === "done" || event === "error") completed = true;
        }
      }
    }
    if (!completed) throw new Error("The response stream ended unexpectedly");
  } finally {
    reader.releaseLock();
  }
}
