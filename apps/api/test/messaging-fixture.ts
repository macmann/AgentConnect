import { randomUUID } from "node:crypto";
import type { GraphTransport } from "../src/microsoft-graph-client.js";
export function messagingFixture(kind: "teams" | "slack") {
  const credential =
    kind === "teams"
      ? {
          tenantId: randomUUID(),
          clientId: randomUUID(),
          clientSecret: "fixture-client-secret",
        }
      : { token: "xoxp-fixture-user-token" };
  const selection = {
    teamId: kind === "teams" ? randomUUID() : "TFIXTURE",
    channelId: kind === "teams" ? "19:fixture@thread.tacv2" : "CFIXTURE",
    maxObjects: 10,
  };
  const state = {
    visible: true,
    denied: false,
    foreign: false,
    shared: false,
    next: "",
    text: "Refunds within 45 days.",
    replyText: "Contact support for help.",
    replies: true,
    invalidParent: false,
    deleted: false,
    broadcast: false,
  };
  const requests: {
    url: string;
    method: string;
    authorization: string | undefined;
  }[] = [];
  let closed = 0;
  const transport: GraphTransport = async (
    raw,
    headers,
    _body,
    _signal,
    method,
  ) => {
    const u = new URL(raw);
    requests.push({
      url: raw,
      method: method ?? "POST",
      authorization: headers.authorization,
    });
    let value: unknown,
      status = 200;
    const root =
      kind === "teams"
        ? {
            id: "100",
            createdDateTime: "2026-10-10T00:00:00Z",
            lastModifiedDateTime: "2026-10-10T00:00:00Z",
            replyToId: null,
            deletedDateTime: state.deleted ? "2026-10-10T01:00:00Z" : null,
            body: {
              contentType: "html",
              content: state.deleted
                ? null
                : `<p>${state.text}</p><script>unsafe()</script>`,
            },
            from: { user: { displayName: "Fixture author" } },
          }
        : {
            ts: "1791580000.000001",
            text: state.text,
            user: "UFIXTURE",
            reply_count: state.replies ? 1 : 0,
          };
    const child =
      kind === "teams"
        ? {
            ...root,
            id: "101",
            replyToId: state.invalidParent ? "other" : "100",
            deletedDateTime: null,
            body: { contentType: "text", content: state.replyText },
          }
        : {
            ts: "1791580001.000001",
            thread_ts: state.invalidParent
              ? "1791580009.000001"
              : "1791580000.000001",
            text: state.replyText,
            user: "UFIXTURE",
          };
    if (u.hostname === "login.microsoftonline.com")
      value = {
        access_token: "fixture-access-token",
        expires_in: 3600,
        token_type: "Bearer",
      };
    else if (state.denied) {
      status = 403;
      value = { error: "secret-provider-error" };
    } else if (kind === "teams") {
      if (u.pathname.endsWith("/replies"))
        value = { value: state.replies ? [child] : [] };
      else if (u.pathname.endsWith("/messages"))
        value = {
          value: state.visible ? [root] : [],
          ...(state.next ? { "@odata.nextLink": state.next } : {}),
        };
      else
        value = {
          id: state.foreign ? "19:foreign@thread.tacv2" : selection.channelId,
          displayName: "Support",
          membershipType: state.shared ? "shared" : "standard",
        };
    } else {
      if (u.pathname.endsWith("auth.test"))
        value = {
          ok: true,
          team_id: state.foreign ? "TFOREIGN" : selection.teamId,
        };
      else if (u.pathname.endsWith("conversations.info"))
        value = {
          ok: true,
          channel: {
            id: selection.channelId,
            name: "support",
            is_member: true,
            is_ext_shared: state.shared,
          },
        };
      else if (u.pathname.endsWith("conversations.replies"))
        value = {
          ok: true,
          messages: state.replies ? [root, child] : [root],
          has_more: false,
        };
      else
        value = {
          ok: true,
          messages: state.visible
            ? state.broadcast
              ? [root, { ...child, subtype: "thread_broadcast" }]
              : [root]
            : [],
          has_more: !!state.next,
          response_metadata: { next_cursor: state.next },
        };
    }
    return {
      status,
      headers: {},
      body: (async function* () {
        yield Buffer.from(JSON.stringify(value));
      })(),
      close: async () => {
        closed++;
      },
    };
  };
  return {
    credential,
    selection,
    state,
    requests,
    transport,
    get closed() {
      return closed;
    },
  };
}
