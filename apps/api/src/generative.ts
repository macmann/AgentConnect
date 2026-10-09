import { randomUUID, createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  uiBlock,
  componentRegistry,
  type UIResponse,
  type RenderedBlock,
} from "@agentconnect/schemas/generative";
import { agentConfig } from "@agentconnect/schemas/agents";
import { actor, workspaceAccess, audit, id, params } from "./app.js";
import { HttpError } from "./http-error.js";
import { sql } from "./db.js";
import { config } from "./config.js";
import { digest } from "./security.js";
import {
  storeKnowledge,
  readKnowledge,
  deleteKnowledge,
} from "./knowledge-storage.js";
export type Artifact = {
  id: string;
  name: string;
  contentType: string;
  key: string;
  byteSize: number;
};
export function csvCell(value: unknown) {
  let s = value === null ? "" : String(value);
  if (/^[\s]*[=+\-@]|^[\t\r\n]/.test(s)) s = "'" + s;
  return '"' + s.replaceAll('"', '""') + '"';
}
export async function prepareArtifacts(
  response: UIResponse,
  workspaceId: string,
  organizationId: string,
) {
  const artifacts: Artifact[] = [],
    blocks: RenderedBlock[] = [];
  try {
    for (const block of response.blocks) {
      if (block.type !== "file") {
        blocks.push(block);
        continue;
      }
      if (artifacts.length >= 3)
        throw new HttpError(400, "At most three files per response");
      const content =
        block.format === "csv"
          ? [
              block.columns!.map((c) => csvCell(c.label)).join(","),
              ...block.rows!.map((row) =>
                block
                  .columns!.map((c) => csvCell(row[c.key] ?? null))
                  .join(","),
              ),
            ].join("\r\n")
          : block.content!;
      const bytes = Buffer.from(content);
      if (bytes.length === 0 || bytes.length > 500000)
        throw new HttpError(400, "Generated file is empty or too large");
      const artifactId = randomUUID(),
        name =
          (block.title.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 80) ||
            "generated") +
          "." +
          block.format,
        key = `generated/${organizationId}/${workspaceId}/${artifactId}`;
      const contentType =
        block.format === "csv"
          ? "text/csv"
          : block.format === "md"
            ? "text/markdown"
            : "text/plain";
      await storeKnowledge(key, bytes);
      artifacts.push({
        id: artifactId,
        name,
        contentType,
        key,
        byteSize: bytes.length,
      });
      blocks.push({
        type: "file",
        title: block.title,
        format: block.format,
        artifactId,
      });
    }
    return { blocks, artifacts };
  } catch (error) {
    await Promise.allSettled(artifacts.map((a) => deleteKnowledge(a.key)));
    throw error;
  }
}
async function messageAccess(r: FastifyRequest, messageId: string) {
  const [m] =
    await sql`SELECT m.*,c.user_id,c.guest_token_hash,c.deployment_id,c.config_snapshot FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.id=${messageId} AND m.role='assistant'`;
  if (!m) throw new HttpError(404, "Assistant message not found");
  const bearer = r.headers.authorization?.replace(/^Bearer /, "");
  let userId: string | null = null;
  if (m.deployment_id && bearer) {
    const [active] =
      await sql`SELECT d.id FROM deployments d JOIN agents a ON a.id=d.agent_id WHERE d.id=${m.deployment_id} AND d.enabled=true AND a.archived_at IS NULL`;
    if (!active) throw new HttpError(403, "Deployment is no longer available");
    if (bearer.length > 128 || digest(bearer) !== m.guest_token_hash)
      throw new HttpError(403, "Conversation token required");
  } else {
    const u = await actor(r);
    await workspaceAccess(u.id, m.workspace_id, "conversation:view");
    userId = u.id;
  }
  return { m, userId };
}
function signature(artifactId: string, expires: number) {
  return createHmac("sha256", Buffer.from(config.MASTER_KEY, "hex"))
    .update(`artifact-download:${artifactId}:${expires}`)
    .digest("hex");
}
export async function registerGenerativeRoutes(app: FastifyInstance) {
  app.get("/ui/components", async (r) => {
    await actor(r);
    return {
      version: 1,
      components: componentRegistry,
      actions: [
        {
          name: "data.collect",
          confirmation: "confirm",
          description:
            "Store validated values in this conversation; does not execute external code",
        },
      ],
    };
  });
  app.post("/messages/:messageId/actions/:blockId", async (r, reply) => {
    const { m, userId } = await messageAccess(r, id(params(r).messageId));
    const d = z
      .object({
        confirmed: z.literal(true),
        values: z.record(z.string(), z.unknown()),
      })
      .strict()
      .parse(r.body);
    const settings = agentConfig.parse(m.config_snapshot).generative;
    if (!settings.enabled)
      throw new HttpError(403, "Generative actions are disabled");
    if (m.deployment_id && !settings.allowPublicForms)
      throw new HttpError(
        403,
        "Public form collection is disabled for this published version",
      );
    if (!m.deployment_id && m.user_id !== userId)
      throw new HttpError(
        403,
        "Only the conversation owner can submit this action",
      );
    const stored = (m.ui_blocks as RenderedBlock[]).find(
      (b) => "id" in b && b.id === params(r).blockId,
    );
    if (!stored) throw new HttpError(404, "Action not found");
    const block = uiBlock.parse(stored);
    if (block.type !== "form" && block.type !== "action")
      throw new HttpError(400, "This block has no registered action");
    if (!settings.allowedBlocks.includes(block.type))
      throw new HttpError(403, "Component is not allowed");
    const values: Record<string, unknown> = {};
    if (block.type === "action") {
      if (Object.keys(d.values).length)
        throw new HttpError(400, "Action values cannot be replaced");
      Object.assign(values, block.values);
    } else {
      const names = new Set(block.fields.map((f) => f.name));
      if (Object.keys(d.values).some((k) => !names.has(k)))
        throw new HttpError(400, "Unknown form field");
      for (const field of block.fields) {
        const v = d.values[field.name];
        if (v === undefined || v === "" || v === null) {
          if (field.required)
            throw new HttpError(400, `${field.label} is required`);
          continue;
        }
        if (field.type === "number") {
          if (
            typeof v !== "number" ||
            !Number.isFinite(v) ||
            (field.min !== undefined && v < field.min) ||
            (field.max !== undefined && v > field.max)
          )
            throw new HttpError(400, `${field.label} must be a valid number`);
        } else if (field.type === "checkbox") {
          if (typeof v !== "boolean" || (field.required && v !== true))
            throw new HttpError(400, `${field.label} must be checked`);
        } else {
          if (typeof v !== "string" || v.length > 4000)
            throw new HttpError(400, `${field.label} is invalid`);
          if (field.type === "email" && !z.email().safeParse(v).success)
            throw new HttpError(400, `${field.label} must be an email`);
          if (field.type === "select" && !field.options?.includes(v))
            throw new HttpError(400, `${field.label} is not an allowed option`);
          if (field.type === "date" && !z.iso.date().safeParse(v).success)
            throw new HttpError(400, `${field.label} must be a valid date`);
        }
        values[field.name] = v;
      }
    }
    const submissionId = randomUUID();
    await sql.begin(async (tx) => {
      const [created] =
        await tx`INSERT INTO collected_submissions(id,organization_id,workspace_id,message_id,conversation_id,block_id,values,submitted_by) VALUES (${submissionId},${m.organization_id},${m.workspace_id},${m.id},${m.conversation_id},${params(r).blockId!},${tx.json(values as never)},${userId}) ON CONFLICT(message_id,block_id) DO NOTHING RETURNING id`;
      if (!created)
        throw new HttpError(409, "This action has already been submitted");
      if (userId)
        await audit(
          tx,
          r,
          userId,
          "ui.action_submitted",
          submissionId,
          m.organization_id,
          m.workspace_id,
        );
    });
    return reply.code(201).send({ id: submissionId, status: "collected" });
  });
  app.get("/artifacts/:artifactId/grant", async (r) => {
    const [a] =
      await sql`SELECT id,message_id FROM generated_artifacts WHERE id=${id(params(r).artifactId)}`;
    if (!a) throw new HttpError(404, "Artifact not found");
    await messageAccess(r, a.message_id);
    const expires = Math.floor(Date.now() / 1000) + 300;
    return {
      path: `/artifacts/${a.id}/download?expires=${expires}&signature=${signature(a.id, expires)}`,
      expiresAt: new Date(expires * 1000).toISOString(),
    };
  });
  app.get("/artifacts/:artifactId/download", async (r, reply) => {
    const artifactId = id(params(r).artifactId),
      q = z
        .object({
          expires: z.coerce.number().int(),
          signature: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .parse(r.query),
      now = Math.floor(Date.now() / 1000);
    if (
      q.expires < now ||
      q.expires > now + 300 ||
      !timingSafeEqual(
        Buffer.from(q.signature, "hex"),
        Buffer.from(signature(artifactId, q.expires), "hex"),
      )
    )
      throw new HttpError(403, "Download link expired or invalid");
    const [a] =
      await sql`SELECT * FROM generated_artifacts WHERE id=${artifactId}`;
    if (!a) throw new HttpError(404, "Artifact not found");
    const bytes = await readKnowledge(
      a.storage_key,
      AbortSignal.timeout(10000),
    );
    return reply
      .header("cache-control", "no-store")
      .header("content-disposition", `attachment; filename="${a.name}"`)
      .type(a.content_type)
      .send(bytes);
  });
  app.get("/workspaces/:workspaceId/collected-data", async (r) => {
    const u = await actor(r),
      w = await workspaceAccess(
        u.id,
        id(params(r).workspaceId),
        "operations:view",
      );
    const q = z
      .object({
        search: z.string().max(120).default(""),
        before: z.iso.datetime().optional(),
        beforeId: z.uuid().optional(),
      })
      .parse(r.query);
    if (!!q.before !== !!q.beforeId)
      throw new HttpError(400, "Cursor requires before and beforeId");
    return sql`SELECT s.id,s.message_id,s.conversation_id,s.block_id,s.values,s.created_at,a.name AS agent_name FROM collected_submissions s JOIN conversations c ON c.id=s.conversation_id JOIN agents a ON a.id=c.agent_id WHERE s.workspace_id=${w.id} AND s.organization_id=${w.organization_id} AND (${q.search}='' OR strpos(lower(s.values::text),lower(${q.search}))>0) AND (s.created_at,s.id)<(${q.before ?? new Date().toISOString()},${q.beforeId ?? "ffffffff-ffff-ffff-ffff-ffffffffffff"}) ORDER BY s.created_at DESC,s.id DESC LIMIT 100`;
  });
}
