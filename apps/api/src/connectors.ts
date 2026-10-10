import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  connectorInput,
  connectorUpdate,
  sharePointDiscoveryInput,
  oneDriveCredential,
} from "@agentconnect/schemas/connectors";
import { actor, workspaceAccess, id, params, audit } from "./app.js";
import { sql } from "./db.js";
import { HttpError } from "./http-error.js";
import { oneDriveEndpoints } from "./onedrive-adapter.js";
import {
  ConnectorError,
  validateConnectorSelection,
  validateConnectorEndpoint,
  connectorCredentials,
} from "./connector-adapters.js";
import {
  createSharePointClient,
  type SharePointClientFactory,
} from "./sharepoint.js";
async function access(
  r: FastifyRequest,
  cap: "connector:read" | "connector:manage" | "connector:sync",
) {
  const u = await actor(r),
    w = await workspaceAccess(u.id, id(params(r).workspaceId), cap);
  return { u, w };
}
export async function registerConnectorRoutes(
  app: FastifyInstance,
  sharePointFactory: SharePointClientFactory = createSharePointClient,
) {
  app.post(
    "/workspaces/:workspaceId/connectors/sharepoint/discover",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (r) => {
      const { w } = await access(r, "connector:manage");
      const d = sharePointDiscoveryInput.parse(r.body);
      for (const endpoint of oneDriveEndpoints)
        validateConnectorEndpoint(endpoint);
      const credential = oneDriveCredential.parse(
        await connectorCredentials(
          {
            secret_id: d.secretId,
            workspace_id: w.id,
            organization_id: w.organization_id,
          },
          "sharepoint",
        ),
      );
      const client = sharePointFactory(credential);
      const controller = new AbortController();
      const aborted = () => controller.abort();
      r.raw.once("aborted", aborted);
      const signal = AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(60000),
      ]);
      try {
        if (d.action === "site") {
          const site = await client.resolveSite(d.siteUrl, signal);
          return { site, libraries: await client.libraries(site.id, signal) };
        }
        return await client.folders(d.siteId, d.driveId, d.folderId, signal);
      } finally {
        r.raw.removeListener("aborted", aborted);
        client.close();
      }
    },
  );
  app.get("/workspaces/:workspaceId/connectors", async (r) => {
    const { w } = await access(r, "connector:read");
    return sql`SELECT c.id,c.name,c.kind,c.knowledge_base_id,c.secret_id,c.selection,c.enabled,c.revision,c.schedule_minutes,c.next_sync_at,c.created_at,k.name AS knowledge_name,latest.status,latest.counts,latest.error_code,latest.finished_at FROM enterprise_connectors c JOIN knowledge_bases k ON k.id=c.knowledge_base_id LEFT JOIN LATERAL(SELECT status,counts,error_code,finished_at FROM connector_syncs WHERE connector_id=c.id ORDER BY created_at DESC,id DESC LIMIT 1) latest ON true WHERE c.workspace_id=${w.id} AND c.archived_at IS NULL ORDER BY c.created_at DESC`;
  });
  app.post("/workspaces/:workspaceId/connectors", async (r, reply) => {
    const { u, w } = await access(r, "connector:manage"),
      d = connectorInput.parse(r.body),
      cid = randomUUID();
    validateConnectorSelection(d.kind, d.selection);
    await connectorCredentials(
      {
        secret_id: d.secretId,
        workspace_id: w.id,
        organization_id: w.organization_id,
      },
      d.kind,
    );
    await sql.begin(async (tx) => {
      const [kb] =
        await tx`SELECT id FROM knowledge_bases WHERE id=${d.knowledgeBaseId} AND workspace_id=${w.id} AND organization_id=${w.organization_id} AND archived_at IS NULL FOR SHARE`;
      if (!kb) throw new HttpError(404, "Knowledge base unavailable");
      await tx`INSERT INTO enterprise_connectors(id,organization_id,workspace_id,name,kind,knowledge_base_id,secret_id,selection,schedule_minutes,next_sync_at,created_by,updated_by) VALUES (${cid},${w.organization_id},${w.id},${d.name},${d.kind},${kb.id},${d.secretId},${tx.json(d.selection)},${d.scheduleMinutes},${d.scheduleMinutes ? new Date(Date.now() + d.scheduleMinutes * 60000) : null},${u.id},${u.id})`;
      await audit(
        tx,
        r,
        u.id,
        "connector.created",
        cid,
        w.organization_id,
        w.id,
      );
    });
    return reply.code(201).send({ id: cid, revision: 1 });
  });
  app.put("/workspaces/:workspaceId/connectors/:connectorId", async (r) => {
    const { u, w } = await access(r, "connector:manage"),
      d = connectorUpdate.parse(r.body);
    const [existing] =
      await sql`SELECT kind FROM enterprise_connectors WHERE id=${id(params(r).connectorId)} AND workspace_id=${w.id} AND archived_at IS NULL`;
    if (!existing) throw new HttpError(404, "Connector unavailable");
    if (d.enabled)
      await connectorCredentials(
        {
          secret_id: d.secretId,
          workspace_id: w.id,
          organization_id: w.organization_id,
        },
        existing.kind,
      );
    else {
      const [credential] =
        await sql`SELECT id FROM secrets WHERE id=${d.secretId} AND workspace_id=${w.id} AND organization_id=${w.organization_id}`;
      if (!credential) throw new HttpError(404, "Credential unavailable");
    }
    return sql.begin(async (tx) => {
      const [c] =
        await tx`UPDATE enterprise_connectors SET selection=jsonb_set(selection,'{maxObjects}',to_jsonb(COALESCE(${d.maxObjects ?? null}::int,(selection->>'maxObjects')::int))),name=${d.name},secret_id=${d.secretId},enabled=${d.enabled},schedule_minutes=${d.scheduleMinutes},next_sync_at=${d.enabled && d.scheduleMinutes ? new Date(Date.now() + d.scheduleMinutes * 60000) : null},updated_by=${u.id},revision=revision+1 WHERE id=${id(params(r).connectorId)} AND workspace_id=${w.id} AND revision=${d.revision} AND archived_at IS NULL RETURNING id,revision`;
      if (!c)
        throw new HttpError(409, "Connector changed or unavailable; reload");
      await tx`UPDATE connector_syncs SET status='cancelled',finished_at=now(),lease_token=NULL,lease_until=NULL WHERE connector_id=${c.id} AND status IN ('queued','running')`;
      await audit(
        tx,
        r,
        u.id,
        "connector.updated",
        c.id,
        w.organization_id,
        w.id,
      );
      return c;
    });
  });
  app.delete("/workspaces/:workspaceId/connectors/:connectorId", async (r) => {
    const { u, w } = await access(r, "connector:manage");
    await sql.begin(async (tx) => {
      const [c] =
        await tx`UPDATE enterprise_connectors SET archived_at=now(),enabled=false,revision=revision+1,next_sync_at=NULL,secret_id=NULL WHERE id=${id(params(r).connectorId)} AND workspace_id=${w.id} AND archived_at IS NULL RETURNING id`;
      if (!c) throw new HttpError(404, "Connector unavailable");
      await tx`UPDATE connector_syncs SET status='cancelled',finished_at=now(),lease_token=NULL,lease_until=NULL WHERE connector_id=${c.id} AND status IN ('queued','running')`;
      await audit(
        tx,
        r,
        u.id,
        "connector.archived",
        c.id,
        w.organization_id,
        w.id,
      );
    });
    return { archived: true, sourcesRetained: true };
  });
  app.post(
    "/workspaces/:workspaceId/connectors/:connectorId/sync",
    async (r, reply) => {
      const { u, w } = await access(r, "connector:sync");
      await workspaceAccess(u.id, w.id, "knowledge:manage");
      const syncId = randomUUID();
      await sql.begin(async (tx) => {
        const [c] =
          await tx`SELECT c.* FROM enterprise_connectors c JOIN knowledge_bases k ON k.id=c.knowledge_base_id WHERE c.id=${id(params(r).connectorId)} AND c.workspace_id=${w.id} AND c.archived_at IS NULL AND k.archived_at IS NULL FOR UPDATE OF c`;
        if (!c) throw new HttpError(404, "Connector unavailable");
        if (!c.enabled) throw new HttpError(409, "Connector is paused");
        const [existing] =
          await tx`SELECT id FROM connector_syncs WHERE connector_id=${c.id} AND status IN ('queued','running')`;
        if (existing)
          throw new HttpError(409, "A sync is already queued or running");
        await tx`INSERT INTO connector_syncs(id,connector_id,organization_id,workspace_id,requested_by,connector_revision,status) VALUES (${syncId},${c.id},${w.organization_id},${w.id},${u.id},${c.revision},'queued')`;
        await audit(
          tx,
          r,
          u.id,
          "connector.sync_queued",
          syncId,
          w.organization_id,
          w.id,
        );
      });
      return reply.code(202).send({ id: syncId, status: "queued" });
    },
  );
  app.get(
    "/workspaces/:workspaceId/connectors/:connectorId/syncs",
    async (r) => {
      const { w } = await access(r, "connector:read");
      const [c] =
        await sql`SELECT id FROM enterprise_connectors WHERE id=${id(params(r).connectorId)} AND workspace_id=${w.id} AND archived_at IS NULL`;
      if (!c) throw new HttpError(404, "Connector unavailable");
      return sql`SELECT id,status,attempts,counts,error_code,created_at,finished_at FROM connector_syncs WHERE connector_id=${c.id} ORDER BY created_at DESC,id DESC LIMIT 50`;
    },
  );
  app.post(
    "/workspaces/:workspaceId/connectors/:connectorId/syncs/:syncId/cancel",
    async (r) => {
      const { u, w } = await access(r, "connector:sync");
      await sql.begin(async (tx) => {
        const [c] =
          await tx`SELECT id FROM enterprise_connectors WHERE id=${id(params(r).connectorId)} AND workspace_id=${w.id} AND archived_at IS NULL FOR UPDATE`;
        if (!c) throw new HttpError(404, "Connector unavailable");
        const [job] =
          await tx`UPDATE connector_syncs SET status='cancelled',finished_at=now(),lease_token=NULL,lease_until=NULL WHERE id=${id(params(r).syncId)} AND connector_id=${c.id} AND status IN ('queued','running') RETURNING id`;
        if (!job)
          throw new HttpError(409, "Sync unavailable or already finished");
        await audit(
          tx,
          r,
          u.id,
          "connector.sync_cancelled",
          job.id,
          w.organization_id,
          w.id,
        );
      });
      return { status: "cancelled" };
    },
  );
}
export function connectorHttpError(error: unknown) {
  if (error instanceof ConnectorError)
    return new HttpError(
      error.code === "CONNECTOR_ENDPOINT_NOT_ALLOWED" ? 400 : 409,
      error.code === "CONNECTOR_ENDPOINT_NOT_ALLOWED"
        ? "Connector endpoint is not approved. Google Drive requires www.googleapis.com and oauth2.googleapis.com; OneDrive, SharePoint and Teams require graph.microsoft.com and login.microsoftonline.com; Slack requires slack.com. Add its exact host to CONNECTOR_ALLOWED_HOSTS in the API and worker environment, preserving existing hosts, then restart both services. Trusted private endpoints require CONNECTOR_PRIVATE_HOSTS."
        : error.code === "CONNECTOR_CREDENTIAL_INVALID"
          ? "Credential JSON must match the provider: S3 needs accessKeyId and secretAccessKey; Google Drive needs service-account client_email and an RSA private_key; OneDrive/SharePoint/Teams need tenantId, clientId and clientSecret; Slack needs a user token in a JSON token field (xoxp-...)."
          : error.code,
    );
  return null;
}
