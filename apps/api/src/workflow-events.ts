import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { sql } from "./db.js";
import { digest } from "./security.js";
import { actor, workspaceAccess, HttpError, id, params, audit } from "./app.js";
import { schemaValidator } from "./workflow-v2.js";
import { workflowJson } from "@agentconnect/schemas/workflow-values";
import { redact } from "./tool-runtime.js";
export async function registerWorkflowEvents(app: FastifyInstance) {
  // Token issuance/rotation is a privileged, audited action. Tokens are never included in run history.
  app.post("/workflow-runs/:runId/event-token", async (r, reply) => {
    reply.header("Cache-Control", "no-store");
    const u = await actor(r);
    const [run] =
      await sql`SELECT * FROM workflow_runs WHERE id=${id(params(r).runId)}`;
    if (!run) throw new HttpError(404, "Run unavailable");
    await workspaceAccess(u.id, run.workspace_id, "workflow:execute");
    const nodeId = z
      .string()
      .regex(/^[A-Za-z][A-Za-z0-9_-]{0,47}$/)
      .parse(z.object({ nodeId: z.string() }).parse(r.body).nodeId);
    const token = randomBytes(32).toString("hex");
    return sql.begin(async (tx) => {
      const [s] =
        await tx`UPDATE workflow_suspensions s SET token_hash=${digest(token)} FROM workflow_runs run WHERE s.run_id=run.id AND s.run_id=${run.id} AND s.node_id=${nodeId} AND s.kind='event' AND s.status='pending' AND s.due_at>now() AND run.status='waiting' AND NOT run.cancel_requested RETURNING s.id,s.due_at,s.payload->>'eventName' AS event_name`;
      if (!s) throw new HttpError(409, "This run is not waiting for the event");
      await audit(
        tx,
        r,
        u.id,
        "workflow.event_token_issued",
        s.id,
        run.organization_id,
        run.workspace_id,
      );
      return {
        suspensionId: s.id,
        token,
        expiresAt: s.due_at,
        eventName: s.event_name,
        callbackPath: `/workflow-events/${s.id}`,
      };
    });
  });
  app.post(
    "/workflow-events/:suspensionId",
    {
      bodyLimit: 20000,
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
    },
    async (r, reply) => {
      reply.header("Cache-Control", "no-store");
      const token = r.headers.authorization?.match(
        /^Bearer ([a-f0-9]{64})$/,
      )?.[1];
      if (!token)
        throw new HttpError(401, "Invalid or expired workflow event token");
      const suspensionId = id(params(r).suspensionId);
      const data = z
        .strictObject({
          eventName: z.string().min(1).max(100),
          data: workflowJson,
        })
        .parse(r.body);
      return sql.begin(async (tx) => {
        const [s] =
          await tx`SELECT s.*,r.status AS run_status,r.cancel_requested FROM workflow_suspensions s JOIN workflow_runs r ON r.id=s.run_id WHERE s.id=${suspensionId} AND s.kind='event' AND s.token_hash=${digest(token)} AND s.due_at>now() FOR UPDATE OF s`;
        if (
          !s ||
          s.cancel_requested ||
          !["running", "waiting"].includes(s.run_status)
        )
          throw new HttpError(401, "Invalid or expired workflow event token");
        if (s.status !== "pending")
          throw new HttpError(409, "Event already received");
        if (data.eventName !== s.payload.eventName)
          throw new HttpError(400, "Event name does not match this wait");
        if (!schemaValidator(s.payload.outputSchema)(data.data))
          throw new HttpError(
            400,
            "Event data does not match the configured schema",
          );
        const result = redact(data.data);
        // Validate after redaction as well; downstream data must retain the promised type.
        if (!schemaValidator(s.payload.outputSchema)(result))
          throw new HttpError(
            400,
            "Event data cannot be retained safely with this schema",
          );
        await tx`UPDATE workflow_suspensions SET status='ready',result=${tx.json(result as never)} WHERE id=${s.id}`;
        return { accepted: true };
      });
    },
  );
}
