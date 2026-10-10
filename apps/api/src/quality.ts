import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  datasetInput,
  runInput,
  gateInput,
} from "@agentconnect/schemas/quality";
import { agentConfig } from "@agentconnect/schemas/agents";
import { actor, workspaceAccess, id, params, audit } from "./app.js";
import { sql } from "./db.js";
import { HttpError } from "./http-error.js";
import { modelSnapshot } from "./agents.js";
import { validateAgentModel } from "./agent-models.js";
import { qualityFingerprint } from "./quality-gate.js";
export async function registerQualityRoutes(app: FastifyInstance) {
  app.get("/workspaces/:workspaceId/quality-models", async (r) => {
    const u = await actor(r),
      w = await workspaceAccess(
        u.id,
        id(params(r).workspaceId),
        "quality:read",
      );
    return sql`SELECT id,name FROM model_configurations WHERE workspace_id=${w.id} AND archived_at IS NULL ORDER BY name`;
  });
  app.get("/workspaces/:workspaceId/datasets", async (r) => {
    const u = await actor(r),
      w = await workspaceAccess(
        u.id,
        id(params(r).workspaceId),
        "quality:read",
      );
    return sql`SELECT * FROM evaluation_datasets WHERE workspace_id=${w.id} AND archived_at IS NULL ORDER BY created_at DESC`;
  });
  app.post("/workspaces/:workspaceId/datasets", async (r, reply) => {
    const u = await actor(r),
      w = await workspaceAccess(
        u.id,
        id(params(r).workspaceId),
        "quality:manage",
      ),
      d = datasetInput.parse(r.body),
      datasetId = randomUUID();
    await sql.begin(async (tx) => {
      await tx`INSERT INTO evaluation_datasets(id,organization_id,workspace_id,name,description,examples) VALUES (${datasetId},${w.organization_id},${w.id},${d.name},${d.description},${tx.json(d.examples)})`;
      await audit(
        tx,
        r,
        u.id,
        "dataset.created",
        datasetId,
        w.organization_id,
        w.id,
      );
    });
    return reply.code(201).send({ id: datasetId, revision: 1 });
  });
  app.put("/workspaces/:workspaceId/datasets/:datasetId", async (r) => {
    const u = await actor(r),
      w = await workspaceAccess(
        u.id,
        id(params(r).workspaceId),
        "quality:manage",
      ),
      body = z
        .object({
          revision: z.number().int().positive(),
          dataset: datasetInput,
        })
        .strict()
        .parse(r.body);
    return sql.begin(async (tx) => {
      const [saved] =
        await tx`UPDATE evaluation_datasets SET name=${body.dataset.name},description=${body.dataset.description},examples=${tx.json(body.dataset.examples)},revision=revision+1 WHERE id=${id(params(r).datasetId)} AND workspace_id=${w.id} AND revision=${body.revision} AND archived_at IS NULL RETURNING id,revision`;
      if (!saved)
        throw new HttpError(409, "Dataset changed or unavailable; reload");
      await audit(
        tx,
        r,
        u.id,
        "dataset.updated",
        saved.id,
        w.organization_id,
        w.id,
      );
      return saved;
    });
  });
  app.delete("/workspaces/:workspaceId/datasets/:datasetId", async (r) => {
    const u = await actor(r),
      w = await workspaceAccess(
        u.id,
        id(params(r).workspaceId),
        "quality:manage",
      );
    return sql.begin(async (tx) => {
      const [d] =
        await tx`UPDATE evaluation_datasets SET archived_at=now(),revision=revision+1 WHERE id=${id(params(r).datasetId)} AND workspace_id=${w.id} AND archived_at IS NULL RETURNING id`;
      if (!d) throw new HttpError(404, "Dataset unavailable");
      await audit(
        tx,
        r,
        u.id,
        "dataset.archived",
        d.id,
        w.organization_id,
        w.id,
      );
      return { archived: true };
    });
  });
  app.post(
    "/workspaces/:workspaceId/datasets/:datasetId/import-messages",
    async (r) => {
      const u = await actor(r),
        w = await workspaceAccess(
          u.id,
          id(params(r).workspaceId),
          "quality:manage",
        );
      await workspaceAccess(u.id, w.id, "conversation:view");
      const body = z
        .object({
          revision: z.number().int().positive(),
          messageIds: z.array(z.uuid()).min(1).max(100),
        })
        .strict()
        .parse(r.body);
      return sql.begin(async (tx) => {
        const [d] =
          await tx`SELECT * FROM evaluation_datasets WHERE id=${id(params(r).datasetId)} AND workspace_id=${w.id} AND archived_at IS NULL FOR UPDATE`;
        if (!d || d.revision !== body.revision)
          throw new HttpError(409, "Dataset changed or unavailable");
        const rows =
          await tx`SELECT m.id,m.content,p.content AS input,review.corrected_response,review.reason FROM messages m JOIN LATERAL (SELECT content FROM messages WHERE run_id=m.run_id AND role='user' ORDER BY created_at,id LIMIT 1) p ON true LEFT JOIN LATERAL (SELECT corrected_response,reason FROM conversation_reviews WHERE message_id=m.id AND corrected_response IS NOT NULL ORDER BY created_at DESC,id DESC LIMIT 1) review ON true WHERE m.workspace_id=${w.id} AND m.role='assistant' AND m.id IN ${tx(body.messageIds)}`;
        if (rows.length !== new Set(body.messageIds).size)
          throw new HttpError(
            404,
            "One or more assistant messages are unavailable",
          );
        const examples = datasetInput.parse({
          name: d.name,
          description: d.description,
          examples: [
            ...d.examples,
            ...rows.map((m) => ({
              input: m.input,
              expectedBehavior: m.reason || "Match the reviewed response",
              expectedAnswer: m.corrected_response ?? m.content,
              tags: ["conversation"],
              metadata: { messageId: m.id },
            })),
          ],
        }).examples;
        const [saved] =
          await tx`UPDATE evaluation_datasets SET examples=${tx.json(examples)},revision=revision+1 WHERE id=${d.id} RETURNING id,revision`;
        await audit(
          tx,
          r,
          u.id,
          "dataset.messages_imported",
          d.id,
          w.organization_id,
          w.id,
        );
        return saved;
      });
    },
  );
  app.get("/workspaces/:workspaceId/evaluations", async (r) => {
    const u = await actor(r),
      w = await workspaceAccess(
        u.id,
        id(params(r).workspaceId),
        "quality:read",
      );
    return sql`SELECT id,agent_id,dataset_id,agent_revision,dataset_revision,evaluator,status,summary,error_code,baseline_run_id,created_at FROM evaluation_runs WHERE workspace_id=${w.id} ORDER BY created_at DESC LIMIT 100`;
  });
  app.get("/workspaces/:workspaceId/evaluations/:evaluationId", async (r) => {
    const u = await actor(r),
      w = await workspaceAccess(
        u.id,
        id(params(r).workspaceId),
        "quality:read",
      );
    const [run] =
      await sql`SELECT id,status,summary,error_code,examples_snapshot,baseline_run_id FROM evaluation_runs WHERE id=${id(params(r).evaluationId)} AND workspace_id=${w.id}`;
    if (!run) throw new HttpError(404, "Evaluation unavailable");
    return {
      ...run,
      results:
        await sql`SELECT example_id,status,output,score,passed,metrics,error_code FROM evaluation_results WHERE run_id=${run.id} ORDER BY created_at,example_id`,
    };
  });
  app.post("/workspaces/:workspaceId/evaluations", async (r, reply) => {
    const u = await actor(r),
      w = await workspaceAccess(
        u.id,
        id(params(r).workspaceId),
        "quality:execute",
      ),
      body = runInput.parse(r.body),
      runId = randomUUID();
    await sql.begin(async (tx) => {
      const [a] =
        await tx`SELECT * FROM agents WHERE id=${body.agentId} AND workspace_id=${w.id} AND archived_at IS NULL FOR SHARE`;
      const [d] =
        await tx`SELECT * FROM evaluation_datasets WHERE id=${body.datasetId} AND workspace_id=${w.id} AND archived_at IS NULL FOR SHARE`;
      if (!a || !d) throw new HttpError(404, "Agent or dataset unavailable");
      if (a.revision !== body.revision)
        throw new HttpError(409, "Draft changed; reload");
      const examples = datasetInput.parse({
        name: d.name,
        description: d.description,
        examples: d.examples,
      }).examples;
      if (!examples.length)
        throw new HttpError(400, "Add dataset examples first");
      if (
        body.evaluator.mode === "deterministic" &&
        examples.some(
          (e) =>
            !e.expectedAnswer &&
            !e.contains.length &&
            !e.forbidden.length &&
            !e.expectedSourceIds.length,
        )
      )
        throw new HttpError(
          400,
          "Each deterministic example needs an expected answer, required term, forbidden term or expected source",
        );
      const c = agentConfig.parse(a.draft_config);
      if (c.generative.enabled)
        throw new HttpError(
          400,
          "Structured generative agents are not yet supported by offline evaluation",
        );
      const model = await modelSnapshot(c.modelId, w.id);
      validateAgentModel(c, model);
      const judge =
        body.evaluator.mode === "judge"
          ? await modelSnapshot(body.evaluator.judgeModelId!, w.id)
          : null;
      const prices =
        await tx`SELECT model_id,input_usd_per_million::float8,output_usd_per_million::float8 FROM model_prices WHERE workspace_id=${w.id}`;
      const fingerprint = await qualityFingerprint(c, model, w.id, tx);
      if (body.baselineRunId) {
        const [baseline] =
          await tx`SELECT id FROM evaluation_runs WHERE id=${body.baselineRunId} AND workspace_id=${w.id} AND agent_id=${a.id} AND dataset_id=${d.id} AND dataset_revision=${d.revision} AND evaluator=${tx.json(body.evaluator)} AND status='completed'`;
        if (!baseline)
          throw new HttpError(
            400,
            "Baseline must be a completed evaluation of this agent, dataset revision and evaluator",
          );
      }
      await tx`INSERT INTO evaluation_runs(id,organization_id,workspace_id,agent_id,dataset_id,requested_by,agent_revision,dataset_revision,config_snapshot,model_snapshot,examples_snapshot,evaluator,judge_snapshot,prices_snapshot,fingerprint,baseline_run_id) VALUES (${runId},${w.organization_id},${w.id},${a.id},${d.id},${u.id},${a.revision},${d.revision},${tx.json(c)},${tx.json(model)},${tx.json(examples)},${tx.json(body.evaluator)},${judge ? tx.json(judge) : null},${tx.json(prices)},${fingerprint},${body.baselineRunId ?? null})`;
      await audit(
        tx,
        r,
        u.id,
        "evaluation.queued",
        runId,
        w.organization_id,
        w.id,
      );
    });
    return reply.code(202).send({ id: runId, status: "queued" });
  });
  app.post(
    "/workspaces/:workspaceId/evaluations/:evaluationId/cancel",
    async (r) => {
      const u = await actor(r),
        w = await workspaceAccess(
          u.id,
          id(params(r).workspaceId),
          "quality:execute",
        );
      return sql.begin(async (tx) => {
        const [run] =
          await tx`UPDATE evaluation_runs SET status='cancelled',finished_at=now(),lease_token=NULL,lease_until=NULL WHERE id=${id(params(r).evaluationId)} AND workspace_id=${w.id} AND status IN ('queued','running') RETURNING id`;
        if (!run)
          throw new HttpError(
            409,
            "Evaluation unavailable or already finished",
          );
        await audit(
          tx,
          r,
          u.id,
          "evaluation.cancelled",
          run.id,
          w.organization_id,
          w.id,
        );
        return { status: "cancelled" };
      });
    },
  );
  app.get("/workspaces/:workspaceId/quality-gates", async (r) => {
    const u = await actor(r),
      w = await workspaceAccess(
        u.id,
        id(params(r).workspaceId),
        "quality:read",
      );
    return sql`SELECT agent_id,settings FROM agent_quality_gates WHERE workspace_id=${w.id}`;
  });
  app.put("/workspaces/:workspaceId/quality-gates/:agentId", async (r) => {
    const u = await actor(r),
      w = await workspaceAccess(
        u.id,
        id(params(r).workspaceId),
        "operations:manage",
      ),
      settings = gateInput.parse(r.body);
    await sql.begin(async (tx) => {
      const [a] =
        await tx`SELECT id FROM agents WHERE id=${id(params(r).agentId)} AND workspace_id=${w.id} AND archived_at IS NULL FOR UPDATE`;
      if (!a) throw new HttpError(404, "Agent unavailable");
      if (settings.enabled) {
        const [d] =
          await tx`SELECT id FROM evaluation_datasets WHERE id=${settings.datasetId} AND workspace_id=${w.id} AND archived_at IS NULL`;
        if (!d) throw new HttpError(404, "Dataset unavailable");
      }
      await tx`INSERT INTO agent_quality_gates(agent_id,organization_id,workspace_id,settings,updated_by) VALUES (${a.id},${w.organization_id},${w.id},${tx.json(settings)},${u.id}) ON CONFLICT(agent_id) DO UPDATE SET settings=EXCLUDED.settings,updated_by=EXCLUDED.updated_by,updated_at=now()`;
      await audit(
        tx,
        r,
        u.id,
        "quality_gate.updated",
        a.id,
        w.organization_id,
        w.id,
      );
    });
    return { saved: true };
  });
}
