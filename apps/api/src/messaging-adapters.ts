import { createHash } from "node:crypto";
import { z } from "zod";
import { load } from "cheerio";
import { safeHttpTransport } from "@agentconnect/provider-sdk";
import {
  teamsSelection,
  slackSelection,
  oneDriveCredential,
  slackCredential,
} from "@agentconnect/schemas/connectors";
import {
  ConnectorError,
  type SourceAdapter,
  type RemoteDocument,
} from "./connector-adapters.js";
import {
  createMicrosoftGraphClient,
  consumeGraphResponse,
  safeGraphOperation,
  type GraphTransport,
} from "./microsoft-graph-client.js";
import { config } from "./config.js";
import { hosts } from "./knowledge-core.js";

// A complete bounded scan is kept in memory until the worker imports it. Never
// reconcile removals against a truncated history or an incomplete replies scan.
function snapshots(maxObjects: number) {
  const documents: RemoteDocument[] = [],
    content = new Map<string, Buffer>();
  let total = 0,
    scanned = 0;
  return {
    documents,
    count() {
      if (++scanned > maxObjects)
        throw new ConnectorError("CONNECTOR_SOURCE_LIMIT");
    },
    add(key: string, url: string, text: string, allowIdentical = false) {
      const bytes = Buffer.from(text);
      const existing = content.get(key);
      if (existing) {
        if (allowIdentical && existing.equals(bytes)) return;
        throw new ConnectorError(
          allowIdentical
            ? "CONNECTOR_OBJECT_CHANGED"
            : "CONNECTOR_INVALID_LISTING",
        );
      }
      total += bytes.length;
      if (bytes.length > 1000000 || total > 10000000)
        throw new ConnectorError("CONNECTOR_OBJECT_LIMIT");
      const fingerprint = createHash("sha256").update(bytes).digest("hex");
      content.set(key, bytes);
      documents.push({
        key,
        url,
        fingerprint,
        size: bytes.length,
        filename: `message-${key}.txt`,
      });
    },
    async read(document: RemoteDocument, signal: AbortSignal) {
      signal.throwIfAborted();
      const bytes = content.get(document.key);
      if (
        !bytes ||
        createHash("sha256").update(bytes).digest("hex") !==
          document.fingerprint
      )
        throw new ConnectorError("CONNECTOR_OBJECT_CHANGED");
      return Promise.resolve(bytes);
    },
    clear() {
      documents.length = 0;
      content.clear();
      total = 0;
      scanned = 0;
    },
  };
}
const graphMessage = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
  replyToId: z.string().nullable().optional(),
  createdDateTime: z.iso.datetime({ offset: true }),
  lastModifiedDateTime: z.iso.datetime({ offset: true }),
  deletedDateTime: z.string().nullable().optional(),
  body: z.object({
    contentType: z.enum(["text", "html"]),
    content: z
      .string()
      .max(1000000)
      .nullable()
      .transform((value) => value ?? ""),
  }),
  from: z
    .object({
      user: z
        .object({ displayName: z.string().max(500).nullable().optional() })
        .nullable()
        .optional(),
    })
    .nullable()
    .optional(),
});
export function createTeamsAdapter(
  selection: z.infer<typeof teamsSelection>,
  credential: z.infer<typeof oneDriveCredential>,
  transport?: GraphTransport,
): SourceAdapter {
  selection = teamsSelection.parse(selection);
  const graph = createMicrosoftGraphClient(credential, transport),
    snapshot = snapshots(selection.maxObjects);
  const channelPath = `/v1.0/teams/${selection.teamId}/channels/${encodeURIComponent(selection.channelId)}`;
  async function channel(signal: AbortSignal) {
    const result = z
      .object({
        id: z.string(),
        membershipType: z.literal("standard"),
        displayName: z.string().max(500),
      })
      .parse(
        await graph.json(`https://graph.microsoft.com${channelPath}`, signal),
      );
    if (result.id !== selection.channelId)
      throw new ConnectorError("CONNECTOR_CHANNEL_MISMATCH");
    return result;
  }
  async function messages(
    path: string,
    signal: AbortSignal,
    visit: (message: z.infer<typeof graphMessage>) => Promise<void>,
  ) {
    let next = `https://graph.microsoft.com${path}?$top=50`;
    const seen = new Set<string>();
    while (next) {
      signal.throwIfAborted();
      const u = new URL(next);
      if (
        u.origin !== "https://graph.microsoft.com" ||
        u.pathname !== path ||
        u.username ||
        u.password ||
        u.hash ||
        seen.has(next) ||
        seen.size >= 100
      )
        throw new ConnectorError("CONNECTOR_INVALID_LISTING");
      seen.add(next);
      const page = z
        .object({
          value: z.array(graphMessage),
          "@odata.nextLink": z.string().optional(),
        })
        .parse(await graph.json(next, signal));
      for (const message of page.value) {
        snapshot.count();
        await visit(message);
      }
      next = page["@odata.nextLink"] ?? "";
    }
  }
  function add(
    message: z.infer<typeof graphMessage>,
    channelName: string,
    parent?: string,
  ) {
    if ((message.replyToId ?? undefined) !== parent)
      throw new ConnectorError("CONNECTOR_INVALID_LISTING");
    if (message.deletedDateTime) return;
    let text = message.body.content;
    if (message.body.contentType === "html") {
      const $ = load(text);
      $("script,style,iframe,object").remove();
      $("br").replaceWith("\n");
      $("p,div,li").append("\n");
      text = $.root().text();
    }
    if (!text.trim()) return;
    const url = `https://teams.microsoft.com/l/message/${encodeURIComponent(selection.channelId)}/${message.id}?groupId=${selection.teamId}&tenantId=${credential.tenantId}`;
    snapshot.add(
      message.id,
      url,
      `Teams channel: ${channelName}\nMessage: ${message.id}\nThread: ${parent ?? message.id}\nAuthor: ${message.from?.user?.displayName ?? "Unknown"}\nCreated: ${message.createdDateTime}\nUpdated: ${message.lastModifiedDateTime}\nSource: ${url}\n\n${text.trim()}`,
    );
  }
  return {
    list(signal) {
      return safeGraphOperation(async () => {
        snapshot.clear();
        const selected = await channel(signal);
        const roots = new Set<string>();
        await messages(channelPath + "/messages", signal, async (message) => {
          if (roots.has(message.id))
            throw new ConnectorError("CONNECTOR_INVALID_LISTING");
          roots.add(message.id);
          add(message, selected.displayName);
          await messages(
            channelPath + `/messages/${message.id}/replies`,
            signal,
            async (reply) => {
              add(reply, selected.displayName, message.id);
            },
          );
        });
        await channel(signal);
        return snapshot.documents;
      }, signal);
    },
    read: snapshot.read,
    close() {
      snapshot.clear();
      graph.close();
    },
  };
}
const slackMessage = z.object({
  ts: z.string().regex(/^\d{10,20}\.\d{6}$/),
  thread_ts: z
    .string()
    .regex(/^\d{10,20}\.\d{6}$/)
    .optional(),
  text: z.string().max(1000000).default(""),
  user: z.string().max(100).optional(),
  subtype: z.string().max(100).optional(),
  reply_count: z.number().int().min(0).max(1000000).optional(),
  edited: z.object({ ts: z.string().max(100) }).optional(),
});
export function createSlackAdapter(
  selection: z.infer<typeof slackSelection>,
  credential: z.infer<typeof slackCredential>,
  transport: GraphTransport = safeHttpTransport(
    hosts(config.CONNECTOR_ALLOWED_HOSTS),
    hosts(config.CONNECTOR_PRIVATE_HOSTS),
  ),
): SourceAdapter {
  selection = slackSelection.parse(selection);
  credential = slackCredential.parse(credential);
  const snapshot = snapshots(selection.maxObjects);
  async function api(
    method: string,
    query: Record<string, string>,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const u = new URL(`https://slack.com/api/${method}`);
    u.search = new URLSearchParams(query).toString();
    const response = await transport(
      u.toString(),
      { authorization: `Bearer ${credential.token}` },
      null,
      signal,
      "GET",
    );
    let result;
    try {
      result = z
        .object({ ok: z.boolean(), error: z.string().optional() })
        .passthrough()
        .parse(
          JSON.parse(
            (await consumeGraphResponse(response, signal)).toString("utf8"),
          ),
        );
    } finally {
      await response.close();
    }
    if (!result.ok)
      throw new ConnectorError(
        [
          "invalid_auth",
          "not_authed",
          "token_revoked",
          "account_inactive",
          "missing_scope",
          "not_in_channel",
          "channel_not_found",
        ].includes(result.error ?? "")
          ? "CONNECTOR_ACCESS_DENIED"
          : result.error === "ratelimited"
            ? "CONNECTOR_RATE_LIMITED"
            : "CONNECTOR_PROVIDER_ERROR",
      );
    return result;
  }
  async function channel(signal: AbortSignal) {
    const auth = await api("auth.test", {}, signal);
    if (auth.team_id !== selection.teamId)
      throw new ConnectorError("CONNECTOR_WORKSPACE_MISMATCH");
    const info = z
      .object({
        channel: z.object({
          id: z.string(),
          name: z.string().max(500),
          is_member: z.literal(true),
          is_im: z.boolean().optional(),
          is_mpim: z.boolean().optional(),
          is_ext_shared: z.boolean().optional(),
          pending_shared: z.array(z.unknown()).optional(),
          context_team_id: z.string().optional(),
        }),
      })
      .parse(
        await api(
          "conversations.info",
          { channel: selection.channelId },
          signal,
        ),
      );
    const c = info.channel;
    if (
      c.id !== selection.channelId ||
      c.is_im ||
      c.is_mpim ||
      c.is_ext_shared ||
      c.pending_shared?.length ||
      (c.context_team_id && c.context_team_id !== selection.teamId)
    )
      throw new ConnectorError("CONNECTOR_CHANNEL_MISMATCH");
    return c;
  }
  async function messages(
    method: string,
    query: Record<string, string>,
    signal: AbortSignal,
    visit: (m: z.infer<typeof slackMessage>) => Promise<void>,
  ) {
    let cursor = "";
    const seen = new Set<string>();
    do {
      const page = z
        .object({
          messages: z.array(slackMessage),
          has_more: z.boolean().optional(),
          response_metadata: z
            .object({ next_cursor: z.string().max(10000).optional() })
            .optional(),
        })
        .parse(
          await api(
            method,
            { ...query, limit: "15", ...(cursor ? { cursor } : {}) },
            signal,
          ),
        );
      for (const message of page.messages) await visit(message);
      cursor = page.response_metadata?.next_cursor?.trim() ?? "";
      if (
        (page.has_more && !cursor) ||
        (cursor && seen.has(cursor)) ||
        seen.size >= 100
      )
        throw new ConnectorError("CONNECTOR_INVALID_LISTING");
      if (cursor) seen.add(cursor);
    } while (cursor);
  }
  function add(m: z.infer<typeof slackMessage>, name: string, parent?: string) {
    if ((m.thread_ts ?? m.ts) !== (parent ?? m.ts))
      throw new ConnectorError("CONNECTOR_INVALID_LISTING");
    if (m.subtype === "message_deleted" || !m.text.trim()) return;
    const url = `https://app.slack.com/client/${selection.teamId}/${selection.channelId}?message_ts=${m.ts}`;
    snapshot.add(
      m.ts,
      url,
      `Slack channel: #${name}\nMessage: ${m.ts}\nThread: ${parent ?? m.ts}\nAuthor: ${m.user ?? "Unknown"}\nUpdated: ${m.edited?.ts ?? m.ts}\nSource: ${url}\n\n${m.text}`,
      true,
    );
  }
  return {
    list(signal) {
      return safeGraphOperation(async () => {
        snapshot.clear();
        const selected = await channel(signal),
          roots = new Set<string>();
        await messages(
          "conversations.history",
          { channel: selection.channelId },
          signal,
          async (m) => {
            snapshot.count();
            if (roots.has(m.ts))
              throw new ConnectorError("CONNECTOR_INVALID_LISTING");
            roots.add(m.ts);
            add(
              m,
              selected.name,
              m.thread_ts !== m.ts ? m.thread_ts : undefined,
            );
            if (m.reply_count) {
              let replies = 0,
                rootSeen = false;
              const children = new Set<string>();
              await messages(
                "conversations.replies",
                { channel: selection.channelId, ts: m.ts },
                signal,
                async (reply) => {
                  if (reply.ts === m.ts) {
                    if (
                      rootSeen ||
                      reply.text !== m.text ||
                      reply.edited?.ts !== m.edited?.ts ||
                      reply.reply_count !== m.reply_count
                    )
                      throw new ConnectorError("CONNECTOR_OBJECT_CHANGED");
                    rootSeen = true;
                    return;
                  }
                  snapshot.count();
                  if (children.has(reply.ts))
                    throw new ConnectorError("CONNECTOR_INVALID_LISTING");
                  children.add(reply.ts);
                  replies++;
                  add(reply, selected.name, m.ts);
                },
              );
              if (!rootSeen || replies !== m.reply_count)
                throw new ConnectorError("CONNECTOR_OBJECT_CHANGED");
            }
          },
        );
        await channel(signal);
        return snapshot.documents;
      }, signal);
    },
    read: snapshot.read,
    close() {
      snapshot.clear();
    },
  };
}
