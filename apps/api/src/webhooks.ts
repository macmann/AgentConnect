import type { TransactionSql } from "postgres";
import { randomUUID, createHmac } from "node:crypto";
import { safeTransport, type Transport } from "@agentconnect/provider-sdk";
import { sql } from "./db.js";
import { config } from "./config.js";
import { decrypt } from "./security.js";
export async function queueRunWebhooks(
  tx: TransactionSql,
  run: {
    id: string;
    workspaceId: string;
    organizationId: string;
    status: string;
    traceId: string;
  },
) {
  const hooks =
    await tx`SELECT id FROM workspace_webhooks WHERE workspace_id=${run.workspaceId} AND organization_id=${run.organizationId} AND enabled=true`;
  for (const hook of hooks) {
    const deliveryId = randomUUID();
    await tx`INSERT INTO webhook_deliveries(id,webhook_id,workspace_id,organization_id,payload) VALUES (${deliveryId},${hook.id},${run.workspaceId},${run.organizationId},${tx.json({ id: deliveryId, type: "agent.run.finished", runId: run.id, status: run.status, traceId: run.traceId })})`;
  }
}
export async function processWebhookDelivery(transport?: Transport) {
  const job = await sql.begin(async (tx) => {
    await tx`UPDATE webhook_deliveries SET status='failed',error_code='WEBHOOK_LEASE_EXPIRED',lease_until=NULL WHERE status='sending' AND lease_until<now() AND attempts>=5`;
    const [row] =
      await tx`SELECT d.id,d.webhook_id,d.payload,d.attempts,h.url,h.signing_secret FROM webhook_deliveries d JOIN workspace_webhooks h ON h.id=d.webhook_id WHERE h.enabled=true AND d.attempts<5 AND ((d.status='pending' AND d.next_attempt_at<=now()) OR (d.status='sending' AND d.lease_until<now())) ORDER BY d.created_at FOR UPDATE OF d SKIP LOCKED LIMIT 1`;
    if (!row) return null;
    await tx`UPDATE webhook_deliveries SET status='sending',attempts=attempts+1,lease_until=now()+interval '30 seconds' WHERE id=${row.id}`;
    return row;
  });
  if (!job) return false;
  const attempt = Number(job.attempts) + 1;
  let httpStatus: number | null = null,
    errorCode: string | null = null;
  const controller = new AbortController(),
    timer = setTimeout(() => controller.abort(), 10000);
  try {
    const secret = decrypt(job.signing_secret, `webhook:${job.webhook_id}`),
      timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac("sha256", secret)
      .update(`${timestamp}.${JSON.stringify(job.payload)}`)
      .digest("hex");
    const send =
      transport ??
      safeTransport(
        config.WEBHOOK_ALLOWED_HOSTS.split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      );
    const response = await send(
      job.url,
      {
        "content-type": "application/json",
        "x-agentconnect-id": job.id,
        "x-agentconnect-timestamp": timestamp,
        "x-agentconnect-signature": `sha256=${signature}`,
      },
      job.payload,
      controller.signal,
    );
    try {
      httpStatus = response.status;
      if (response.status < 200 || response.status >= 300)
        errorCode = "WEBHOOK_HTTP_ERROR";
    } finally {
      await response.close();
    }
  } catch {
    errorCode = controller.signal.aborted
      ? "WEBHOOK_TIMEOUT"
      : "WEBHOOK_DELIVERY_FAILED";
  } finally {
    clearTimeout(timer);
  }
  const retryable =
    errorCode !== null &&
    (httpStatus === null || httpStatus === 429 || httpStatus >= 500);
  const status =
    errorCode === null
      ? "delivered"
      : retryable && attempt < 5
        ? "pending"
        : "failed";
  await sql`UPDATE webhook_deliveries SET status=${status},error_code=${errorCode},http_status=${httpStatus},lease_until=NULL,next_attempt_at=now()+${Math.min(3600, 30 * 2 ** attempt)}*interval '1 second',delivered_at=${status === "delivered" ? new Date() : null} WHERE id=${job.id} AND status='sending' AND attempts=${attempt}`;
  return true;
}
