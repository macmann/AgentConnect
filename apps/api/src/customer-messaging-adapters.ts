import {
  createHmac,
  timingSafeEqual,
  createPublicKey,
  verify,
} from "node:crypto";
import { safeHttpTransport } from "@agentconnect/provider-sdk";
import type { MessagingProvider } from "@agentconnect/schemas/messaging";
export type Credentials = Record<string, string>;
export type Address = {
  serviceUrl?: string;
  conversationId?: string;
  recipientId?: string;
  botId?: string;
  activityId?: string;
  pageId?: string;
};
export type IncomingMessage = {
  eventId: string;
  externalId: string;
  text: string;
  address: Address;
};
export type MessagingHttp = ReturnType<typeof safeHttpTransport>;
export const messagingHosts = [
  "graph.facebook.com",
  "chatapi.viber.com",
  "api.telegram.org",
  "login.microsoftonline.com",
  "login.botframework.com",
];
export const defaultMessagingHttp = safeHttpTransport(messagingHosts);
export class MessagingError extends Error {
  constructor(
    public code: string,
    public retryable = false,
  ) {
    super(code);
  }
}
type MessengerEvent = {
  message?: { is_echo?: boolean; text?: string; mid?: string };
  sender?: { id?: string };
};
type ProviderObject = {
  [key: string]: unknown;
  error?: unknown;
  ok?: boolean;
  status?: number;
  keys?: import("node:crypto").JsonWebKey[];
  access_token?: string;
  result?: { username?: string };
  name?: string;
  id?: string;
  alg?: string;
  kid?: string;
  iss?: string;
  aud?: string;
  exp?: number;
  nbf?: number;
  serviceurl?: string;
  channelId?: string;
  serviceUrl?: string;
  channelData?: { tenant?: { id?: string } };
  object?: string;
  entry?: { id: string; messaging?: MessengerEvent[] }[];
  message?: {
    text?: string;
    type?: string;
    chat?: { id?: number; type?: string };
    from?: { is_bot?: boolean };
  };
  update_id?: number;
  event?: string;
  sender?: { id?: string };
  message_token?: string | number;
  type?: string;
  text?: string;
  conversation?: { id?: string; conversationType?: string };
  from?: { id?: string };
  recipient?: { id?: string };
};
const object = (v: unknown): ProviderObject =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as ProviderObject) : {};
export async function messagingJson(
  http: MessagingHttp,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  method: "GET" | "POST" = "POST",
) {
  let r;
  try {
    r = await http(url, headers, body, AbortSignal.timeout(15000), method);
  } catch {
    throw new MessagingError("CHANNEL_NETWORK_ERROR", true);
  }
  try {
    if (r.status < 200 || r.status >= 300)
      throw new MessagingError(
        "CHANNEL_HTTP_" + r.status,
        r.status === 429 || r.status >= 500,
      );
    let size = 0;
    const chunks: Uint8Array[] = [];
    for await (const chunk of r.body) {
      size += chunk.byteLength;
      if (size > 1024 * 1024)
        throw new MessagingError("CHANNEL_RESPONSE_LIMIT");
      chunks.push(chunk);
    }
    const d = object(JSON.parse(Buffer.concat(chunks).toString()));
    if (
      d.error ||
      d.ok === false ||
      (typeof d.status === "number" && d.status !== 0)
    )
      throw new MessagingError("CHANNEL_CREDENTIAL_OR_CONFIGURATION_REJECTED");
    return d;
  } finally {
    await r.close();
  }
}
export function validSignature(
  raw: string,
  key: string,
  supplied: string | undefined,
  prefix = "",
) {
  if (!supplied?.startsWith(prefix)) return false;
  const value = supplied.slice(prefix.length);
  if (!/^[a-fA-F0-9]{64}$/.test(value)) return false;
  const actual = createHmac("sha256", key).update(raw).digest();
  return timingSafeEqual(actual, Buffer.from(value, "hex"));
}
export function equalSecret(a: string | undefined, b: string) {
  return (
    !!a &&
    a.length <= 256 &&
    timingSafeEqual(
      createHmac("sha256", b).update(a).digest(),
      createHmac("sha256", b).update(b).digest(),
    )
  );
}
export function teamsServiceUrl(value: string) {
  const u = new URL(value);
  if (
    u.protocol !== "https:" ||
    u.port ||
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    !(
      u.hostname === "smba.trafficmanager.net" ||
      u.hostname.endsWith(".botframework.com")
    )
  )
    throw new MessagingError("TEAMS_SERVICE_URL_REJECTED");
  return u.href.replace(/\/$/, "");
}
type KeySet = { keys: import("node:crypto").JsonWebKey[] };
let keyCache: { expires: number; value: KeySet } | undefined;
export async function verifyTeamsActivity(
  authorization: string | undefined,
  credentials: Credentials,
  body: unknown,
  http: MessagingHttp = defaultMessagingHttp,
) {
  const parts = authorization?.replace(/^Bearer /, "").split(".");
  if (
    !parts ||
    parts.length !== 3 ||
    parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p)) ||
    authorization!.length > 16000
  )
    throw new MessagingError("CHANNEL_SIGNATURE_INVALID");
  const header = object(
      JSON.parse(Buffer.from(parts[0]!, "base64url").toString()),
    ),
    claims = object(JSON.parse(Buffer.from(parts[1]!, "base64url").toString()));
  const now = Date.now() / 1000;
  if (
    header.alg !== "RS256" ||
    claims.iss !== "https://api.botframework.com" ||
    claims.aud !== credentials.appId ||
    typeof claims.exp !== "number" ||
    claims.exp < now - 60 ||
    typeof claims.nbf !== "number" ||
    claims.nbf > now + 60
  )
    throw new MessagingError("CHANNEL_SIGNATURE_INVALID");
  if (
    !keyCache ||
    keyCache.expires < Date.now() ||
    !keyCache.value.keys.some((k) => k.kid === header.kid)
  ) {
    const d = await messagingJson(
      http,
      "https://login.botframework.com/v1/.well-known/keys",
      {},
      undefined,
      "GET",
    );
    if (!Array.isArray(d.keys))
      throw new MessagingError("TEAMS_KEYS_UNAVAILABLE", true);
    keyCache = { expires: Date.now() + 3600000, value: { keys: d.keys } };
  }
  const key = keyCache.value.keys.find(
    (k) =>
      k.kid === header.kid && k.kty === "RSA" && (!k.use || k.use === "sig"),
  );
  if (
    !key ||
    !verify(
      "RSA-SHA256",
      Buffer.from(parts[0] + "." + parts[1]),
      createPublicKey({ key, format: "jwk" }),
      Buffer.from(parts[2]!, "base64url"),
    )
  )
    throw new MessagingError("CHANNEL_SIGNATURE_INVALID");
  const activity = object(body);
  if (
    activity.channelId !== "msteams" ||
    typeof claims.serviceurl !== "string" ||
    claims.serviceurl !== activity.serviceUrl
  )
    throw new MessagingError("CHANNEL_SIGNATURE_INVALID");
  teamsServiceUrl(activity.serviceUrl!);
  if (
    credentials.tenantId &&
    object(object(activity.channelData).tenant).id !== credentials.tenantId
  )
    throw new MessagingError("TEAMS_TENANT_REJECTED");
}
export function incomingMessages(
  provider: MessagingProvider,
  body: unknown,
): IncomingMessage[] {
  const d = object(body),
    result: IncomingMessage[] = [];
  if (provider === "messenger" && d.object === "page") {
    for (const entry of (Array.isArray(d.entry) ? d.entry : []).slice(0, 20))
      for (const e of (Array.isArray(entry.messaging)
        ? entry.messaging
        : []
      ).slice(0, 50)) {
        if (
          !e.message?.is_echo &&
          typeof e.message?.text === "string" &&
          typeof e.message?.mid === "string" &&
          typeof e.sender?.id === "string"
        )
          result.push({
            eventId: e.message.mid,
            externalId: e.sender.id,
            text: e.message.text,
            address: { pageId: String(entry.id), recipientId: e.sender.id },
          });
      }
  }
  if (provider === "telegram") {
    const m = d.message ?? {};
    if (
      typeof m.text === "string" &&
      Number.isSafeInteger(d.update_id) &&
      Number.isSafeInteger(m.chat?.id) &&
      m.chat!.type === "private" &&
      !m.from?.is_bot
    )
      result.push({
        eventId: String(d.update_id),
        externalId: String(m.chat!.id),
        text: m.text,
        address: { recipientId: String(m.chat!.id) },
      });
  }
  if (
    provider === "viber" &&
    d.event === "message" &&
    d.message?.type === "text" &&
    typeof d.message.text === "string" &&
    typeof d.sender?.id === "string" &&
    (typeof d.message_token === "string" ||
      Number.isSafeInteger(d.message_token))
  )
    result.push({
      eventId: String(d.message_token),
      externalId: d.sender.id,
      text: d.message.text,
      address: { recipientId: d.sender.id },
    });
  if (
    provider === "teams" &&
    d.type === "message" &&
    typeof d.text === "string" &&
    typeof d.id === "string" &&
    typeof d.conversation?.id === "string" &&
    typeof d.from?.id === "string" &&
    d.conversation.conversationType === "personal"
  )
    result.push({
      eventId: d.id,
      externalId: d.conversation.id + ":" + d.from.id,
      text: d.text.replace(/<at>[^<]*<\/at>/g, "").trim(),
      address: {
        serviceUrl: teamsServiceUrl(d.serviceUrl!),
        conversationId: d.conversation.id,
        recipientId: d.from.id,
        botId: d.recipient?.id,
        activityId: d.id,
      },
    });
  return result.filter(
    (m) =>
      m.text.trim() &&
      m.text.length <= 12000 &&
      m.eventId.length <= 300 &&
      m.externalId.length <= 500,
  );
}
export async function teamsToken(c: Credentials, http: MessagingHttp) {
  if (
    !/^[0-9a-f-]{36}$/i.test(c.appId ?? "") ||
    (c.tenantId && !/^[0-9a-f-]{36}$/i.test(c.tenantId))
  )
    throw new MessagingError("TEAMS_APP_CONFIGURATION_INVALID");
  const d = await messagingJson(
    http,
    `https://login.microsoftonline.com/${c.tenantId || "botframework.com"}/oauth2/v2.0/token`,
    { "content-type": "application/x-www-form-urlencoded" },
    new URLSearchParams({
      grant_type: "client_credentials",
      client_id: c.appId!,
      client_secret: c.appSecret!,
      scope: "https://api.botframework.com/.default",
    }).toString(),
  );
  if (typeof d.access_token !== "string")
    throw new MessagingError("TEAMS_AUTHENTICATION_FAILED");
  return d.access_token;
}
export async function connectMessaging(
  provider: MessagingProvider,
  c: Credentials,
  callback: string,
  http: MessagingHttp = defaultMessagingHttp,
) {
  if (provider === "telegram") {
    if (!/^\d+:[A-Za-z0-9_-]+$/.test(c.token ?? ""))
      throw new MessagingError("TELEGRAM_TOKEN_INVALID");
    const base = `https://api.telegram.org/bot${c.token}`,
      me = await messagingJson(http, base + "/getMe", {}, {});
    await messagingJson(
      http,
      base + "/setWebhook",
      { "content-type": "application/json" },
      {
        url: callback,
        secret_token: c.webhookSecret,
        allowed_updates: ["message"],
        drop_pending_updates: false,
      },
    );
    return {
      identity: String(me.result?.username ?? "Telegram bot"),
      webhookRegistered: true,
    };
  }
  if (provider === "viber") {
    const headers = {
        "content-type": "application/json",
        "x-viber-auth-token": c.token!,
      },
      me = await messagingJson(
        http,
        "https://chatapi.viber.com/pa/get_account_info",
        headers,
        {},
      );
    await messagingJson(
      http,
      "https://chatapi.viber.com/pa/set_webhook",
      headers,
      {
        url: callback,
        event_types: ["conversation_started", "subscribed", "unsubscribed"],
        send_name: false,
        send_photo: false,
      },
    );
    return {
      identity: String(me.name ?? "Viber bot"),
      webhookRegistered: true,
    };
  }
  if (provider === "messenger") {
    const headers = {
        authorization: "Bearer " + c.token,
        "content-type": "application/json",
      },
      me = await messagingJson(
        http,
        "https://graph.facebook.com/v23.0/me?fields=id,name",
        headers,
        undefined,
        "GET",
      );
    if (!/^\d+$/.test(String(me.id ?? "")))
      throw new MessagingError("MESSENGER_PAGE_TOKEN_REQUIRED");
    await messagingJson(
      http,
      `https://graph.facebook.com/v23.0/${me.id}/subscribed_apps`,
      headers,
      { subscribed_fields: ["messages", "messaging_postbacks"] },
    );
    return {
      identity: String(me.name ?? "Facebook Page"),
      pageId: String(me.id),
      webhookRegistered: false,
    };
  }
  await teamsToken(c, http);
  return { identity: "Microsoft Teams bot", webhookRegistered: false };
}
export async function sendMessaging(
  provider: MessagingProvider,
  c: Credentials,
  address: Address,
  text: string,
  name: string,
  http: MessagingHttp = defaultMessagingHttp,
  cursor = 0,
  onDelivered?: (offset: number) => Promise<void>,
) {
  const limit =
    provider === "messenger" ? 1900 : provider === "telegram" ? 3900 : 6500;
  // Fixed text delivery preserves safety across channels; rich output remains in hosted chat/widget.
  const characters = Array.from(text);
  for (let offset = cursor; offset < characters.length; offset += limit) {
    const part = characters.slice(offset, offset + limit).join("");
    if (provider === "telegram")
      await messagingJson(
        http,
        `https://api.telegram.org/bot${c.token}/sendMessage`,
        { "content-type": "application/json" },
        { chat_id: address.recipientId, text: part },
      );
    if (provider === "viber")
      await messagingJson(
        http,
        "https://chatapi.viber.com/pa/send_message",
        { "content-type": "application/json", "x-viber-auth-token": c.token! },
        {
          receiver: address.recipientId,
          type: "text",
          text: part,
          sender: { name: name.slice(0, 28) },
        },
      );
    if (provider === "messenger")
      await messagingJson(
        http,
        "https://graph.facebook.com/v23.0/me/messages",
        {
          authorization: "Bearer " + c.token,
          "content-type": "application/json",
        },
        {
          recipient: { id: address.recipientId },
          messaging_type: "RESPONSE",
          message: { text: part },
        },
      );
    if (provider === "teams") {
      const service = teamsServiceUrl(address.serviceUrl!),
        bearer = await teamsToken(c, http),
        guarded =
          http === defaultMessagingHttp
            ? safeHttpTransport([...messagingHosts, new URL(service).host])
            : http;
      await messagingJson(
        guarded,
        `${service}/v3/conversations/${encodeURIComponent(address.conversationId!)}/activities`,
        {
          authorization: "Bearer " + bearer,
          "content-type": "application/json",
        },
        {
          type: "message",
          text: part,
          textFormat: "plain",
          from: { id: address.botId },
          recipient: { id: address.recipientId },
          replyToId: address.activityId,
        },
      );
    }
    if (onDelivered)
      await onDelivered(Math.min(characters.length, offset + limit));
  }
}
