import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { sql } from "./db.js";
import { config } from "./config.js";
import { encrypt, decrypt, token, digest } from "./security.js";
import { channelCredentials } from "./messaging-channels.js";
import {
  sendMessaging,
  MessagingError,
  defaultMessagingHttp,
  type MessagingHttp,
} from "./customer-messaging-adapters.js";

async function customer(
  channel: import("postgres").Row | undefined,
  job: import("postgres").Row,
) {
  if (!channel) throw new MessagingError("CHANNEL_UNAVAILABLE");
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${channel.id + ":" + job.external_id},0))`;
    const [existing] =
      await tx`SELECT * FROM messaging_customers WHERE channel_id=${channel.id} AND external_id=${job.external_id}`;
    if (existing) {
      await tx`UPDATE messaging_customers SET address=${tx.json(job.address)} WHERE channel_id=${channel.id} AND external_id=${job.external_id}`;
      return existing;
    }
    const [d] =
      await tx`SELECT d.*,v.config,v.model_snapshot FROM deployments d JOIN agent_versions v ON v.id=d.version_id JOIN agents a ON a.id=d.agent_id WHERE d.id=${channel.deployment_id} AND d.enabled AND a.archived_at IS NULL`;
    if (!d) throw new MessagingError("CHANNEL_DEPLOYMENT_UNAVAILABLE");
    const raw = token(),
      conversationId = randomUUID();
    await tx`INSERT INTO conversations(id,organization_id,workspace_id,agent_id,version_id,deployment_id,guest_token_hash,config_snapshot,model_snapshot,channel) VALUES(${conversationId},${d.organization_id},${d.workspace_id},${d.agent_id},${d.version_id},${d.id},${digest(raw)},${tx.json(d.config)},${tx.json(d.model_snapshot)},${channel.provider})`;
    const [row] =
      await tx`INSERT INTO messaging_customers(channel_id,external_id,conversation_id,guest_token,address) VALUES(${channel.id},${job.external_id},${conversationId},${tx.json(encrypt(raw, `messaging-customer:${channel.id}:${job.external_id}`))},${tx.json(job.address)}) RETURNING *`;
    return row!;
  });
}
function streamedResponse(body: string) {
  let text = "",
    code: string | undefined,
    completed = false;
  for (const frame of body.split("\n\n")) {
    const type = frame
        .split("\n")
        .find((l) => l.startsWith("event:"))
        ?.slice(6)
        .trim(),
      raw = frame
        .split("\n")
        .find((l) => l.startsWith("data:"))
        ?.slice(5)
        .trim();
    if (!raw) continue;
    const d = JSON.parse(raw) as {
      text?: string;
      message?: string;
      blocks?: { type: string; content?: string }[];
      code?: string;
    };
    if (type === "token") text += d.text ?? "";
    if (type === "ui")
      text =
        d.message ||
        d.blocks
          ?.filter((b) => b.type === "text")
          .map((b) => b.content)
          .join("\n") ||
        "A structured response is available in the conversation.";
    if (type === "done") completed = true;
    if (type === "error") {
      code = /^[A-Z0-9_]{1,80}$/.test(d.code ?? "")
        ? d.code
        : "CHANNEL_AGENT_FAILED";
      text = d.message || "Unable to answer. Please try again later.";
      completed = true;
    }
  }
  if (!completed) throw new MessagingError("CHANNEL_CHAT_INTERRUPTED");
  return { text: text || "No response content. Please contact support.", code };
}
export async function processMessagingJob(
  app: FastifyInstance,
  http: MessagingHttp = defaultMessagingHttp,
) {
  const lease = randomUUID();
  const [job] = await sql.begin(async (tx) => {
    // Never automatically replay an interrupted AI call: it could already have completed.
    await tx`UPDATE messaging_inbox SET status='failed',error_code='CHANNEL_CHAT_INTERRUPTED',lease_owner=NULL,lease_expires_at=NULL WHERE status='processing' AND lease_expires_at<now()`;
    const [next] =
      await tx`SELECT i.* FROM messaging_inbox i JOIN messaging_channels c ON c.id=i.channel_id JOIN deployments d ON d.id=c.deployment_id JOIN agents a ON a.id=d.agent_id WHERE c.enabled AND d.enabled AND a.archived_at IS NULL AND i.status IN ('queued','sending') AND i.next_attempt_at<=now() AND (i.lease_expires_at IS NULL OR i.lease_expires_at<now()) AND NOT EXISTS(SELECT 1 FROM messaging_inbox prior WHERE prior.channel_id=i.channel_id AND prior.external_id=i.external_id AND prior.status IN ('queued','processing','sending') AND (prior.created_at,prior.id)<(i.created_at,i.id)) ORDER BY i.created_at,i.id FOR UPDATE OF i SKIP LOCKED LIMIT 1`;
    if (!next) return [];
    return tx`UPDATE messaging_inbox SET status=${next.reply !== null ? "sending" : "processing"},lease_owner=${lease},lease_expires_at=now()+interval '3 minutes',attempts=attempts+1 WHERE id=${next.id} RETURNING *`;
  });
  if (!job) return false;
  const [channel] =
    await sql`SELECT * FROM messaging_channels WHERE id=${job.channel_id}`;
  try {
    const client = await customer(channel, job),
      raw = decrypt(
        client.guest_token,
        `messaging-customer:${channel!.id}:${job.external_id}`,
      ),
      headers = { origin: config.WEB_ORIGIN, authorization: "Bearer " + raw };
    await sql`UPDATE messaging_inbox SET conversation_id=${client.conversation_id} WHERE id=${job.id} AND lease_owner=${lease}`;
    const ipHash = digest(job.channel_id + ":" + job.external_id),
      remoteAddress = `127.${parseInt(ipHash.slice(0, 2), 16)}.${parseInt(ipHash.slice(2, 4), 16)}.${parseInt(ipHash.slice(4, 6), 16)}`;
    let output = job.reply,
      errorCode = job.error_code;
    if (output === null) {
      const [conversation] =
        await sql`SELECT conversation_mode FROM conversations WHERE id=${client.conversation_id}`;
      const rating = /^\/rating\s+([1-5])\s*$/i.exec(job.content),
        resolved = /^\/resolved\s+(yes|no)\s*$/i.exec(job.content);
      if (/^\/help\s*$/i.test(job.content)) {
        output =
          "Ask a question, send /support to request human support, /rating 1–5 to rate this chat, or /resolved yes or no to report the outcome.";
      } else if (/^\/support\s*$/i.test(job.content)) {
        const response = await app.inject({
          remoteAddress,
          method: "POST",
          url: `/public/deployments/${channel!.deployment_id}/conversations/${client.conversation_id}/handoff`,
          headers,
          payload: { action: "request" },
        });
        output =
          response.statusCode === 201
            ? "Waiting for human support. You can leave a message here."
            : "Human support is unavailable for this conversation right now. Please use the support contact provided by this organization.";
      } else if (rating || resolved) {
        const [answer] =
          await sql`SELECT id FROM messages WHERE conversation_id=${client.conversation_id} AND role='assistant' LIMIT 1`;
        if (!answer)
          output =
            "Ask a question and receive an answer before leaving feedback.";
        else {
          await sql`INSERT INTO customer_feedback(conversation_id,workspace_id,organization_id,rating,resolved) VALUES(${client.conversation_id},${channel!.workspace_id},${channel!.organization_id},${rating ? Number(rating[1]) : null},${resolved ? resolved[1]!.toLowerCase() === "yes" : null}) ON CONFLICT(conversation_id) DO UPDATE SET rating=COALESCE(EXCLUDED.rating,customer_feedback.rating),resolved=COALESCE(EXCLUDED.resolved,customer_feedback.resolved),updated_at=now()`;
          output = "Thank you. Your feedback was saved.";
        }
      } else if (conversation!.conversation_mode !== "ai") {
        const response = await app.inject({
          remoteAddress,
          method: "POST",
          url: `/public/deployments/${channel!.deployment_id}/conversations/${client.conversation_id}/handoff`,
          headers,
          payload: { action: "message", content: job.content },
        });
        if (response.statusCode !== 201)
          throw new MessagingError("CHANNEL_SUPPORT_MESSAGE_FAILED", true);
        output = "Your message was saved for the support team.";
      } else {
        const response = await app.inject({
          remoteAddress,
          method: "POST",
          url: `/public/deployments/${channel!.deployment_id}/chat`,
          headers,
          payload: {
            conversationId: client.conversation_id,
            message: job.content,
          },
        });
        if (response.statusCode !== 200)
          throw new MessagingError(
            "CHANNEL_CHAT_HTTP_" + response.statusCode,
            response.statusCode === 429 || response.statusCode >= 500,
          );
        const parsed = streamedResponse(response.body);
        output = parsed.text;
        const support = await app.inject({
          remoteAddress,
          method: "GET",
          url: `/public/deployments/${channel!.deployment_id}/conversations/${client.conversation_id}/handoff`,
          headers,
        });
        if (support.statusCode === 200 && support.json().access?.offer)
          output += "\nTo connect with a support specialist, send /support.";
        errorCode = parsed.code ?? null;
      }
      await sql`UPDATE messaging_inbox SET reply=${output},error_code=${errorCode},status='sending' WHERE id=${job.id} AND lease_owner=${lease}`;
    }
    const [current] =
      await sql`SELECT c.enabled,d.enabled AS deployment_enabled FROM messaging_channels c JOIN deployments d ON d.id=c.deployment_id WHERE c.id=${channel!.id}`;
    if (!current?.enabled || !current.deployment_enabled)
      throw new MessagingError("CHANNEL_DISCONNECTED");
    await sendMessaging(
      channel!.provider,
      channelCredentials(channel!),
      job.address,
      output,
      channel!.name,
      http,
      job.delivery_offset,
      async (offset) => {
        await sql`UPDATE messaging_inbox SET delivery_offset=${offset} WHERE id=${job.id} AND lease_owner=${lease}`;
      },
    );
    await sql`UPDATE messaging_inbox SET status='completed',lease_owner=NULL,lease_expires_at=NULL WHERE id=${job.id} AND lease_owner=${lease}`;
  } catch (e) {
    const code =
        e instanceof MessagingError ? e.code : "CHANNEL_DELIVERY_FAILED",
      retry = e instanceof MessagingError && e.retryable && job.attempts < 5;
    const [stored] =
      await sql`SELECT reply FROM messaging_inbox WHERE id=${job.id}`;
    await sql`UPDATE messaging_inbox SET status=${retry ? (stored!.reply !== null ? "sending" : "queued") : "failed"},error_code=${code},next_attempt_at=now()+${Math.min(300, 2 ** job.attempts * 5)}*interval '1 second',lease_owner=NULL,lease_expires_at=NULL WHERE id=${job.id} AND lease_owner=${lease}`;
    app.log.warn(
      {
        channelId: job.channel_id,
        eventId: job.id,
        code,
        attempt: job.attempts,
      },
      "Messaging delivery failed",
    );
  }
  return true;
}
export async function queueSupportMessages() {
  const customers =
    await sql`SELECT mc.* FROM messaging_customers mc JOIN messaging_channels c ON c.id=mc.channel_id JOIN deployments d ON d.id=c.deployment_id WHERE c.enabled AND d.enabled AND EXISTS(SELECT 1 FROM handoff_events e WHERE e.conversation_id=mc.conversation_id AND e.kind='operator_message' AND (e.created_at,e.id)>(mc.last_support_at,mc.last_support_id)) ORDER BY mc.last_support_at LIMIT 100`;
  for (const client of customers)
    await sql.begin(async (tx) => {
      const [locked] =
        await tx`SELECT * FROM messaging_customers WHERE channel_id=${client.channel_id} AND external_id=${client.external_id} FOR UPDATE`;
      const events =
        await tx`SELECT * FROM handoff_events WHERE conversation_id=${client.conversation_id} AND kind='operator_message' AND (created_at,id)>(${locked!.last_support_at},${locked!.last_support_id}) ORDER BY created_at,id LIMIT 100`;
      for (const e of events)
        await tx`INSERT INTO messaging_inbox(id,channel_id,event_id,external_id,content,address,status,reply) VALUES(${randomUUID()},${client.channel_id},${"support:" + e.id},${client.external_id},'',${tx.json(client.address)},'sending',${e.content}) ON CONFLICT(channel_id,event_id) DO NOTHING`;
      if (events.length)
        await tx`UPDATE messaging_customers SET last_support_at=${events.at(-1)!.created_at},last_support_id=${events.at(-1)!.id} WHERE channel_id=${client.channel_id} AND external_id=${client.external_id}`;
    });
}
export function startMessagingWorker(app: FastifyInstance) {
  let busy = false,
    stopped = false;
  const timer = setInterval(async () => {
    if (busy || stopped) return;
    busy = true;
    try {
      await queueSupportMessages();
      for (let i = 0; i < 10 && !stopped; i++)
        if (!(await processMessagingJob(app))) break;
    } catch {
      app.log.warn(
        { code: "CHANNEL_QUEUE_UNAVAILABLE" },
        "Messaging queue unavailable",
      );
    } finally {
      busy = false;
    }
  }, 2000);
  timer.unref();
  app.addHook("preClose", async () => {
    stopped = true;
    clearInterval(timer);
  });
}
