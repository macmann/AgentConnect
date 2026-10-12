import { recordAnswerIssue } from "./answer-issues.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { conversationAccess } from "./channels.js";
import { sql } from "./db.js";
import { HttpError } from "./http-error.js";

export async function registerCustomerFeedback(app: FastifyInstance) {
  for (const channel of ["deployments", "widgets"]) {
    const path = `/public/${channel}/:deploymentId/conversations/:conversationId/feedback`;
    app.get(path, async (r) => {
      const { c } = await conversationAccess(r, true);
      const [feedback] =
        await sql`SELECT rating,resolved,comment,updated_at FROM customer_feedback WHERE conversation_id=${c.id}`;
      return feedback ?? { rating: null, resolved: null, comment: "" };
    });
    app.put(path, async (r) => {
      const { c } = await conversationAccess(r, true);
      const data = z
        .strictObject({
          rating: z.number().int().min(1).max(5).nullable(),
          resolved: z.boolean().nullable(),
          comment: z.string().trim().max(2000).default(""),
        })
        .parse(r.body);
      const [answer] =
        await sql`SELECT id FROM messages WHERE conversation_id=${c.id} AND role='assistant' ORDER BY created_at DESC,id DESC LIMIT 1`;
      if (!answer)
        throw new HttpError(409, "Get an answer before leaving feedback");
      await sql.begin(async (tx) => {
        if (
          data.resolved === false ||
          (data.rating !== null && data.rating <= 2)
        )
          await recordAnswerIssue(
            tx,
            answer.id,
            {
              workspace_id: c.workspace_id,
              organization_id: c.organization_id,
            },
            {
              reason: data.resolved === false ? "unresolved" : "not_helpful",
              comment: data.comment,
            },
          );
        await tx`INSERT INTO customer_feedback(conversation_id,workspace_id,organization_id,rating,resolved,comment) VALUES(${c.id},${c.workspace_id},${c.organization_id},${data.rating},${data.resolved},${data.comment}) ON CONFLICT(conversation_id) DO UPDATE SET rating=EXCLUDED.rating,resolved=EXCLUDED.resolved,comment=EXCLUDED.comment,updated_at=now()`;
      });
      return { ok: true };
    });
  }
}
