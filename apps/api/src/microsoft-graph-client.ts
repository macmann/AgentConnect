import { z } from "zod";
import { safeHttpTransport, ProviderError } from "@agentconnect/provider-sdk";
import { oneDriveCredential } from "@agentconnect/schemas/connectors";
import { ConnectorError } from "./connector-adapters.js";
import { config } from "./config.js";
import { hosts } from "./knowledge-core.js";
export const microsoftGraphEndpoints = [
  "https://graph.microsoft.com/v1.0",
  "https://login.microsoftonline.com",
];
export type GraphTransport = ReturnType<typeof safeHttpTransport>;
export function graphStatusError(status: number): never {
  throw new ConnectorError(
    status === 401 || status === 403
      ? "CONNECTOR_ACCESS_DENIED"
      : status === 404
        ? "CONNECTOR_NOT_FOUND"
        : status === 412
          ? "CONNECTOR_OBJECT_CHANGED"
          : status === 429
            ? "CONNECTOR_RATE_LIMITED"
            : "CONNECTOR_PROVIDER_ERROR",
  );
}
export async function consumeGraphResponse(
  response: Awaited<ReturnType<GraphTransport>>,
  signal: AbortSignal,
) {
  if (response.status < 200 || response.status >= 300)
    graphStatusError(response.status);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    signal.throwIfAborted();
    size += chunk.byteLength;
    if (size > 10000000) throw new ConnectorError("CONNECTOR_OBJECT_LIMIT");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
export async function safeGraphOperation<T>(
  fn: () => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  try {
    signal.throwIfAborted();
    return await fn();
  } catch (e) {
    if (e instanceof ConnectorError) throw e;
    if (signal.aborted) throw new ConnectorError("CONNECTOR_CANCELLED");
    if (e instanceof ProviderError)
      throw new ConnectorError("CONNECTOR_NETWORK_ERROR");
    if (
      e instanceof z.ZodError ||
      e instanceof SyntaxError ||
      e instanceof TypeError ||
      e instanceof URIError
    )
      throw new ConnectorError("CONNECTOR_INVALID_LISTING");
    throw new ConnectorError("CONNECTOR_PROVIDER_ERROR");
  }
}
export function createMicrosoftGraphClient(
  credential: z.infer<typeof oneDriveCredential>,
  transport: GraphTransport = safeHttpTransport(
    hosts(config.CONNECTOR_ALLOWED_HOSTS),
    hosts(config.CONNECTOR_PRIVATE_HOSTS),
  ),
) {
  let token = "",
    expiresAt = 0;
  async function jsonResponse(
    response: Awaited<ReturnType<GraphTransport>>,
    signal: AbortSignal,
  ): Promise<unknown> {
    try {
      return JSON.parse(
        (await consumeGraphResponse(response, signal)).toString("utf8"),
      );
    } finally {
      await response.close();
    }
  }
  async function authenticate(signal: AbortSignal) {
    if (token && expiresAt > Date.now() + 60000) return;
    const response = await transport(
      `${microsoftGraphEndpoints[1]}/${credential.tenantId}/oauth2/v2.0/token`,
      { "content-type": "application/x-www-form-urlencoded" },
      new URLSearchParams({
        client_id: credential.clientId,
        client_secret: credential.clientSecret,
        scope: "https://graph.microsoft.com/.default",
        grant_type: "client_credentials",
      }).toString(),
      signal,
      "POST",
    );
    const result = z
      .object({
        access_token: z.string().min(1).max(30000),
        expires_in: z.number().int().min(1).max(86400),
        token_type: z.literal("Bearer"),
      })
      .parse(await jsonResponse(response, signal));
    token = result.access_token;
    expiresAt = Date.now() + result.expires_in * 1000;
  }
  return {
    async get(
      url: string,
      signal: AbortSignal,
      headers: Record<string, string> = {},
    ) {
      const u = new URL(url);
      if (
        u.origin !== "https://graph.microsoft.com" ||
        !u.pathname.startsWith("/v1.0/") ||
        u.username ||
        u.password ||
        u.hash
      )
        throw new ConnectorError("CONNECTOR_INVALID_LISTING");
      await authenticate(signal);
      return transport(
        u.toString(),
        { ...headers, authorization: `Bearer ${token}` },
        null,
        signal,
        "GET",
      );
    },
    async json(url: string, signal: AbortSignal) {
      return jsonResponse(await this.get(url, signal), signal);
    },
    close() {
      token = "";
      expiresAt = 0;
    },
  };
}
export type MicrosoftGraphClient = ReturnType<
  typeof createMicrosoftGraphClient
>;
