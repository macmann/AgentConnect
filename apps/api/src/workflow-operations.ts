import { parseDocument, KnowledgeError } from "@agentconnect/rag/parsers";
import { HttpError } from "./http-error.js";
import { config } from "./config.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { actor, workspaceAccess, id, params } from "./app.js";
import { sql } from "./db.js";
import { storedWorkflowGraph, workflowV2Program } from "./workflow-v2.js";
import { redact } from "./tool-runtime.js";
export async function registerWorkflowOperations(app: FastifyInstance) {
  app.post(
    "/workspaces/:workspaceId/workflow-documents/parse",
    { bodyLimit: 7000000 },
    async (r, reply) => {
      reply.header("Cache-Control", "no-store");
      const u = await actor(r);
      await workspaceAccess(
        u.id,
        id(params(r).workspaceId),
        "workflow:execute",
      );
      const input = z
        .strictObject({
          files: z
            .array(
              z.strictObject({
                name: z
                  .string()
                  .min(1)
                  .max(200)
                  .regex(/\.(pdf|txt|md)$/i),
                data: z
                  .string()
                  .max(6700000)
                  .regex(/^[A-Za-z0-9+/]*={0,2}$/),
              }),
            )
            .min(1)
            .max(25),
        })
        .parse(r.body);
      const documents: { name: string; text: string }[] = [];
      let size = 0;
      try {
        for (const file of input.files) {
          const bytes = Buffer.from(file.data, "base64");
          size += bytes.length;
          if (size > 5000000)
            throw new HttpError(400, "Upload at most 5 MB per document batch");
          const doc = await parseDocument(
            bytes,
            file.name,
            AbortSignal.timeout(30000),
          );
          documents.push({
            name: file.name,
            text: doc.sections.map((s) => s.text).join("\n\n"),
          });
          if (
            Buffer.byteLength(JSON.stringify(documents)) >
            config.WORKFLOW_OUTPUT_BYTES
          )
            throw new HttpError(
              400,
              "Extracted documents exceed the workflow input budget. Split the batch.",
            );
        }
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(
          400,
          error instanceof KnowledgeError
            ? `${error.code}. Scanned PDFs require OCR preprocessing through an existing integration.`
            : "Document parsing failed. Provide native-text PDF or text, or preprocess through OCR.",
        );
      }
      return { documents };
    },
  );
  app.get("/workspaces/:workspaceId/workflow-operations", async (r) => {
    const u = await actor(r),
      w = await workspaceAccess(
        u.id,
        id(params(r).workspaceId),
        "workflow:read",
      );
    const query = z
      .object({
        view: z.enum(["runs", "tasks"]).default("runs"),
        before: z.iso.datetime().optional(),
        beforeId: z.uuid().optional(),
      })
      .parse(r.query);
    if (query.view === "runs")
      return sql`SELECT r.id,r.workflow_id,w.name AS workflow_name,r.status,r.created_at,to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time,r.finished_at,r.error_code,r.parent_run_id,(SELECT jsonb_agg(n.node_id) FROM workflow_node_runs n WHERE n.run_id=r.id AND n.status='running') AS current_nodes,(SELECT count(*)::int FROM workflow_approvals a WHERE a.run_id=r.id AND a.decision='pending') AS human_tasks FROM workflow_runs r JOIN workflows w ON w.id=r.workflow_id WHERE r.workspace_id=${w.id} AND r.organization_id=${w.organization_id} AND (${query.before ?? null}::text::timestamptz IS NULL OR (r.created_at,r.id)<(${query.before ?? null}::text::timestamptz,${query.beforeId ?? "ffffffff-ffff-ffff-ffff-ffffffffffff"}::uuid)) ORDER BY r.created_at DESC,r.id DESC LIMIT 100`;
    const rows =
      await sql`SELECT a.id,a.node_id,a.prompt,a.input,a.created_at,to_char(a.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time,r.id AS run_id,r.workflow_id,r.graph_snapshot,w.name AS workflow_name FROM workflow_approvals a JOIN workflow_runs r ON r.id=a.run_id JOIN workflows w ON w.id=r.workflow_id WHERE r.workspace_id=${w.id} AND r.organization_id=${w.organization_id} AND r.status='waiting' AND a.decision='pending' AND (${query.before ?? null}::text::timestamptz IS NULL OR (a.created_at,a.id)<(${query.before ?? null}::text::timestamptz,${query.beforeId ?? "ffffffff-ffff-ffff-ffff-ffffffffffff"}::uuid)) ORDER BY a.created_at DESC,a.id DESC LIMIT 100`;
    return rows.map((row) => {
      const node = workflowV2Program(
        storedWorkflowGraph(row.graph_snapshot),
      )?.nodes.find((n) => n.id === row.node_id);
      return {
        ...row,
        graph_snapshot: undefined,
        input: redact(row.input),
        task: node?.label ?? row.node_id,
        config:
          node?.kind === "human-task"
            ? node.config
            : {
                mode: "approve-reject",
                approveLabel: "Approve",
                rejectLabel: "Reject",
              },
      };
    });
  });
}
