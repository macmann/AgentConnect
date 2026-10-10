import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { Agent, ProxyAgent, request, buildConnector } from "undici";
export type ProviderName =
  "openai" | "openai-compatible" | "anthropic" | "gemini";
export interface ModelConnection {
  provider: ProviderName;
  modelId: string;
  baseUrl: string;
  apiKey?: string;
  capabilities: { temperature: boolean; topP: boolean };
}
export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}
export interface ChatRequest {
  system: string;
  messages: ChatMessage[];
  temperature: number;
  topP: number | null;
  maxOutputTokens: number;
  signal: AbortSignal;
}
export type ProviderEvent =
  | { type: "token"; text: string }
  | { type: "usage"; inputTokens: number | null; outputTokens: number | null };
export interface ChatProvider {
  stream(input: ChatRequest): AsyncIterable<ProviderEvent>;
}
export type ProviderFactory = (connection: ModelConnection) => ChatProvider;
export class ProviderError extends Error {
  constructor(
    public code: string,
    public retryable = false,
    public httpStatus?: number,
    public details?: { providerCode?: string; parameter?: string },
  ) {
    super("Model provider request failed");
  }
}
export interface TransportResponse {
  status: number;
  body: AsyncIterable<Uint8Array>;
  close: () => Promise<void>;
  headers?: Record<string, string | string[] | undefined>;
}
// Only these fixed identifiers can leave a provider error body. Never expose
// upstream messages, echoed requests, headers, arbitrary codes or field names.
export async function providerErrorDetails(body: AsyncIterable<Uint8Array>) {
  const codes = new Set([
    "model_not_found",
    "invalid_model",
    "unsupported_parameter",
    "unsupported_value",
    "invalid_value",
    "invalid_request_error",
    "context_length_exceeded",
    "insufficient_quota",
    "rate_limit_exceeded",
    "invalid_api_key",
    "permission_denied",
  ]);
  const parameters = new Set([
    "model",
    "temperature",
    "top_p",
    "max_tokens",
    "max_completion_tokens",
    "messages",
    "stream",
    "stream_options",
    "dimensions",
    "input",
  ]);
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of body) {
      size += chunk.byteLength;
      if (size > 16384) return undefined;
      chunks.push(chunk);
    }
    const value = object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    const error = object(value.error);
    const code =
      typeof error.code === "string" && codes.has(error.code)
        ? error.code
        : typeof error.type === "string" && codes.has(error.type)
          ? error.type
          : undefined;
    const parameter =
      typeof error.param === "string" && parameters.has(error.param)
        ? error.param
        : undefined;
    return code || parameter ? { providerCode: code, parameter } : undefined;
  } catch {
    return undefined;
  }
}
export type Transport = (
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal: AbortSignal,
) => Promise<TransportResponse>;
export const defaultBaseUrls: Record<ProviderName, string> = {
  openai: "https://api.openai.com/v1",
  "openai-compatible": "",
  anthropic: "https://api.anthropic.com/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta",
};
export function validateEndpoint(
  baseUrl: string,
  allowedHosts: string[],
  privateHosts: string[] = [],
) {
  const u = new URL(baseUrl);
  if (u.username || u.password || u.search || u.hash)
    throw new ProviderError("INVALID_ENDPOINT");
  const privateAllowed = privateHosts.includes(u.host);
  if (!allowedHosts.includes(u.host) && !privateAllowed)
    throw new ProviderError("ENDPOINT_NOT_ALLOWED");
  if (u.protocol !== "https:" && !(u.protocol === "http:" && privateAllowed))
    throw new ProviderError("HTTPS_REQUIRED");
  return u;
}
const blocked = new BlockList();
for (const [ip, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blocked.addSubnet(ip, prefix, "ipv4");
export function safeTransport(
  allowedHosts: string[],
  privateHosts: string[] = [],
): Transport {
  return safeHttpTransport(allowedHosts, privateHosts);
}
export function safeHttpTransport(
  allowedHosts: string[],
  privateHosts: string[] = [],
): (
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal: AbortSignal,
  method?: "GET" | "POST" | "DELETE",
) => Promise<TransportResponse> {
  return async (url, headers, body, signal, method = "POST") => {
    const u = new URL(url);
    validateEndpoint(`${u.origin}${u.pathname}`, allowedHosts, privateHosts);
    const privateAllowed = privateHosts.includes(u.host);
    const addresses =
      isIP(u.hostname) === 4
        ? [{ address: u.hostname, family: 4 }]
        : await lookup(u.hostname, { all: true, family: 4 });
    if (
      !addresses.length ||
      (!privateAllowed &&
        addresses.some((a) => blocked.check(a.address, "ipv4")))
    )
      throw new ProviderError("PRIVATE_ENDPOINT_BLOCKED");
    const proxy =
      !privateAllowed && (process.env.HTTPS_PROXY || process.env.HTTP_PROXY);
    // Direct connections pin the resolved address while preserving TLS server-name verification.
    const dispatcher = proxy
      ? new ProxyAgent(proxy)
      : new Agent({
          connect: (options, callback) =>
            buildConnector({})(
              {
                ...options,
                hostname: addresses[0]!.address,
                servername: u.hostname,
              },
              callback,
            ),
        });
    try {
      const response = await request(url, {
        method,
        headers,
        body:
          method === "POST"
            ? headers["content-type"] === "application/x-www-form-urlencoded" &&
              typeof body === "string"
              ? body
              : JSON.stringify(body)
            : undefined,
        signal,
        headersTimeout: 30000,
        bodyTimeout: 60000,
        dispatcher,
      });
      return {
        status: response.statusCode,
        headers: response.headers,
        body: response.body,
        close: async () => {
          response.body.on("error", () => {});
          response.body.destroy();
          await dispatcher.close();
        },
      };
    } catch {
      await dispatcher.close();
      throw new ProviderError(
        signal.aborted ? "CANCELLED" : "NETWORK_ERROR",
        !signal.aborted,
      );
    }
  };
}
interface Frame {
  event: string;
  data: string;
}
export async function* decodeSSE(
  body: AsyncIterable<Uint8Array>,
): AsyncIterable<Frame> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer = (buffer + decoder.decode(chunk, { stream: true })).replace(
      /\r\n/g,
      "\n",
    );
    if (buffer.length > 1048576) throw new ProviderError("FRAME_TOO_LARGE");
    let split;
    while ((split = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      let event = "message";
      const data: string[] = [];
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
      }
      if (data.length) yield { event, data: data.join("\n") };
    }
  }
  if (buffer.trim()) throw new ProviderError("INCOMPLETE_STREAM");
}
type Obj = Record<string, unknown>;
const object = (v: unknown): Obj =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {};
const number = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null;
export function createProvider(
  connection: ModelConnection,
  transport: Transport,
): ChatProvider {
  return {
    async *stream(input) {
      const { provider, baseUrl, modelId, apiKey, capabilities } = connection;
      if (provider !== "openai-compatible" && !apiKey)
        throw new ProviderError("MISSING_CREDENTIAL");
      let endpoint: string;
      let headers: Record<string, string> = {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      };
      let payload: Obj;
      const parameters = {
        ...(capabilities.temperature ? { temperature: input.temperature } : {}),
        ...(capabilities.topP && input.topP !== null
          ? { top_p: input.topP }
          : {}),
      };
      if (provider === "anthropic") {
        endpoint = baseUrl.replace(/\/$/, "") + "/messages";
        headers = {
          ...headers,
          "x-api-key": apiKey!,
          "anthropic-version": "2023-06-01",
        };
        payload = {
          model: modelId,
          system: input.system,
          messages: input.messages,
          max_tokens: input.maxOutputTokens,
          stream: true,
          ...parameters,
        };
      } else if (provider === "gemini") {
        endpoint =
          baseUrl.replace(/\/$/, "") +
          `/models/${encodeURIComponent(modelId)}:streamGenerateContent?alt=sse`;
        headers = { ...headers, "x-goog-api-key": apiKey! };
        payload = {
          systemInstruction: { parts: [{ text: input.system }] },
          contents: input.messages.map((m) => ({
            role: m.role === "assistant" ? "model" : "user",
            parts: [{ text: m.content }],
          })),
          generationConfig: {
            maxOutputTokens: input.maxOutputTokens,
            ...(capabilities.temperature
              ? { temperature: input.temperature }
              : {}),
            ...(capabilities.topP && input.topP !== null
              ? { topP: input.topP }
              : {}),
          },
        };
      } else {
        endpoint = baseUrl.replace(/\/$/, "") + "/chat/completions";
        if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
        payload = {
          model: modelId,
          messages: [
            { role: "system", content: input.system },
            ...input.messages,
          ],
          ...(provider === "openai"
            ? { max_completion_tokens: input.maxOutputTokens }
            : { max_tokens: input.maxOutputTokens }),
          stream: true,
          ...parameters,
          ...(provider === "openai"
            ? { stream_options: { include_usage: true } }
            : {}),
        };
      }
      const response = await transport(
        endpoint,
        headers,
        payload,
        input.signal,
      );
      let finished = false;
      let inputTokens: number | null = null;
      try {
        if (response.status < 200 || response.status >= 300)
          throw new ProviderError(
            response.status === 401 || response.status === 403
              ? "AUTHENTICATION_FAILED"
              : response.status === 429
                ? "RATE_LIMITED"
                : "PROVIDER_HTTP_ERROR",
            response.status === 429 || response.status >= 500,
            response.status,
            await providerErrorDetails(response.body),
          );
        for await (const frame of decodeSSE(response.body)) {
          if (frame.data === "[DONE]") {
            finished = true;
            break;
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(frame.data);
          } catch {
            throw new ProviderError("INVALID_PROVIDER_RESPONSE");
          }
          const data = object(parsed);
          if (data.error || frame.event === "error")
            throw new ProviderError("PROVIDER_STREAM_ERROR");
          if (provider === "anthropic") {
            const delta = object(data.delta);
            if (
              data.type === "content_block_delta" &&
              typeof delta.text === "string"
            )
              yield { type: "token", text: delta.text };
            const usage = object(
              data.type === "message_start"
                ? object(data.message).usage
                : data.usage,
            );
            if (usage.input_tokens !== undefined)
              inputTokens = number(usage.input_tokens);
            if (Object.keys(usage).length)
              yield {
                type: "usage",
                inputTokens,
                outputTokens: number(usage.output_tokens),
              };
            if (data.type === "message_stop") finished = true;
          } else if (provider === "gemini") {
            const candidates = Array.isArray(data.candidates)
              ? data.candidates
              : [];
            const candidate = object(candidates[0]);
            const parts = object(candidate.content).parts;
            if (Array.isArray(parts))
              for (const part of parts) {
                const text = object(part).text;
                if (typeof text === "string") yield { type: "token", text };
              }
            if (candidate.finishReason) {
              if (
                candidate.finishReason !== "STOP" &&
                candidate.finishReason !== "MAX_TOKENS"
              )
                throw new ProviderError("RESPONSE_BLOCKED");
              finished = true;
            }
            const usage = object(data.usageMetadata);
            if (Object.keys(usage).length)
              yield {
                type: "usage",
                inputTokens: number(usage.promptTokenCount),
                outputTokens: number(usage.candidatesTokenCount),
              };
          } else {
            const choices = Array.isArray(data.choices) ? data.choices : [];
            const choice = object(choices[0]);
            const text = object(choice.delta).content;
            if (typeof text === "string") yield { type: "token", text };
            if (choice.finish_reason) {
              if (!["stop", "length"].includes(String(choice.finish_reason)))
                throw new ProviderError("RESPONSE_BLOCKED");
              finished = true;
            }
            const usage = object(data.usage);
            if (Object.keys(usage).length)
              yield {
                type: "usage",
                inputTokens: number(usage.prompt_tokens),
                outputTokens: number(usage.completion_tokens),
              };
          }
        }
        if (!finished) throw new ProviderError("INCOMPLETE_STREAM");
      } finally {
        await response.close();
      }
    },
  };
}
