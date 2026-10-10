import type { TransactionSql } from "postgres";
import { randomUUID } from "node:crypto";
import { sql } from "./db.js";
import { workspaceAccess } from "./app.js";
import {
  createSourceAdapter,
  ConnectorError,
  type AdapterFactory,
  type ConnectorRow,
  type SourceAdapter,
} from "./connector-adapters.js";
import { storeKnowledge, deleteKnowledge } from "./knowledge-storage.js";
import { supportedExtensions } from "@agentconnect/rag/parsers";
export async function processConnectorSync(
  factory: AdapterFactory = createSourceAdapter,
) {
  await sql.begin(async (tx) => {
    await tx`UPDATE connector_syncs SET status='failed',error_code='CONNECTOR_RETRY_LIMIT',finished_at=now(),lease_token=NULL,lease_until=NULL WHERE status='running' AND lease_until<now() AND attempts>=3`;
    await tx`UPDATE connector_syncs s SET status='cancelled',finished_at=now(),lease_token=NULL,lease_until=NULL FROM enterprise_connectors c,knowledge_bases k WHERE s.connector_id=c.id AND k.id=c.knowledge_base_id AND s.status IN ('queued','running') AND (NOT c.enabled OR c.archived_at IS NOT NULL OR k.archived_at IS NOT NULL OR c.revision<>s.connector_revision)`;
    const due =
      await tx`SELECT c.* FROM enterprise_connectors c JOIN knowledge_bases k ON k.id=c.knowledge_base_id WHERE c.enabled AND c.archived_at IS NULL AND k.archived_at IS NULL AND c.next_sync_at<=now() ORDER BY c.next_sync_at LIMIT 10 FOR UPDATE OF c SKIP LOCKED`;
    for (const c of due) {
      await tx`INSERT INTO connector_syncs(id,connector_id,organization_id,workspace_id,requested_by,connector_revision,status) VALUES (${randomUUID()},${c.id},${c.organization_id},${c.workspace_id},${c.updated_by},${c.revision},'queued') ON CONFLICT(connector_id) WHERE status IN ('queued','running') DO NOTHING`;
      await tx`UPDATE enterprise_connectors SET next_sync_at=now()+schedule_minutes*interval '1 minute' WHERE id=${c.id}`;
    }
  });
  const lease = randomUUID();
  const [claimedJob] =
    await sql`UPDATE connector_syncs SET status='running',attempts=attempts+1,lease_token=${lease},lease_until=now()+interval '120 seconds' WHERE id=(SELECT id FROM connector_syncs WHERE (status='queued' OR (status='running' AND lease_until<now())) AND attempts<3 ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`;
  if (!claimedJob) return false;
  const job = claimedJob;
  const controller = new AbortController(),
    signal = AbortSignal.any([controller.signal, AbortSignal.timeout(300000)]);
  let adapter: SourceAdapter | undefined;
  let busy = false;
  const heartbeat = setInterval(() => {
    if (busy) return;
    busy = true;
    void sql`UPDATE connector_syncs SET lease_until=now()+interval '120 seconds' WHERE id=${job.id} AND status='running' AND lease_token=${lease} RETURNING id`
      .then((rows) => {
        if (!rows.length) controller.abort();
      })
      .catch(() => controller.abort())
      .finally(() => {
        busy = false;
      });
  }, 10000);
  heartbeat.unref();
  const counts = {
    listed: 0,
    imported: 0,
    updated: 0,
    unchanged: 0,
    removed: 0,
    skipped: 0,
  };
  async function authorize() {
    await workspaceAccess(job.requested_by, job.workspace_id, "connector:sync");
    await workspaceAccess(
      job.requested_by,
      job.workspace_id,
      "knowledge:manage",
    );
  }
  async function current(tx: TransactionSql) {
    const [c] = await tx<
      ConnectorRow[]
    >`SELECT c.* FROM enterprise_connectors c JOIN knowledge_bases k ON k.id=c.knowledge_base_id WHERE c.id=${job.connector_id} AND c.enabled AND c.archived_at IS NULL AND k.archived_at IS NULL AND c.revision=${job.connector_revision} FOR SHARE OF c,k`;
    const [active] =
      await tx`SELECT id FROM connector_syncs WHERE id=${job.id} AND status='running' AND lease_token=${lease} AND lease_until>now() FOR UPDATE`;
    if (!c || !active) throw new ConnectorError("CONNECTOR_CANCELLED");
    return c;
  }
  try {
    await authorize();
    const connector = await sql.begin((tx) => current(tx));
    adapter = await factory(connector);
    const documents = await adapter.list(signal);
    counts.listed = documents.length;
    const keys = new Set<string>();
    for (const document of documents) {
      signal.throwIfAborted();
      if (keys.has(document.key) || document.key.length > 1024)
        throw new ConnectorError("CONNECTOR_INVALID_LISTING");
      keys.add(document.key);
    }
    for (const document of documents) {
      signal.throwIfAborted();
      await authorize();
      if (
        !supportedExtensions.includes(
          document.filename.split(".").pop()?.toLowerCase() ?? "",
        ) ||
        (document.size !== undefined && document.size > 10000000) ||
        document.size === 0
      ) {
        counts.skipped++;
        continue;
      }
      const [mapped] =
        await sql`SELECT i.*,s.revision,s.status,s.knowledge_base_id FROM connector_items i JOIN knowledge_sources s ON s.id=i.source_id WHERE i.connector_id=${connector.id} AND i.external_key=${document.key}`;
      const item = mapped?.status === "deleted" ? undefined : mapped;
      if (
        item &&
        item.fingerprint === document.fingerprint &&
        !["deleted", "failed"].includes(item.status)
      ) {
        await sql.begin(async (tx) => {
          await current(tx);
          await tx`UPDATE connector_items SET last_seen_sync=${job.id} WHERE connector_id=${connector.id} AND external_key=${document.key}`;
        });
        counts.unchanged++;
        continue;
      }
      const bytes = await adapter.read(document, signal);
      if (
        bytes.length === 0 ||
        bytes.length > 10000000 ||
        (document.size !== undefined && bytes.length !== document.size)
      )
        throw new ConnectorError("CONNECTOR_OBJECT_CHANGED");
      const sourceId = item?.source_id ?? randomUUID(),
        revision = item ? item.revision + 1 : 1,
        key = `${connector.organization_id}/${connector.workspace_id}/${connector.knowledge_base_id}/${sourceId}/${revision}/input`;
      await storeKnowledge(key, bytes);
      try {
        await sql.begin(async (tx) => {
          await current(tx);
          if (item) {
            const [source] =
              await tx`SELECT revision FROM knowledge_sources WHERE id=${sourceId} AND knowledge_base_id=${connector.knowledge_base_id} FOR UPDATE`;
            if (!source || source.revision !== item.revision)
              throw new ConnectorError("CONNECTOR_SOURCE_CHANGED");
            await tx`UPDATE knowledge_jobs SET status='cancelled',finished_at=now() WHERE source_id=${sourceId} AND status IN ('queued','running')`;
            await tx`UPDATE knowledge_sources SET title=${document.filename.slice(0, 200)},filename=${document.filename},object_key=${key},byte_size=${bytes.length},source_url=${document.url},metadata=${tx.json({ connectorId: connector.id, externalKey: document.key })},revision=${revision},status='queued',error_code=NULL,updated_at=now() WHERE id=${sourceId}`;
          } else {
            await tx`INSERT INTO knowledge_sources(id,knowledge_base_id,workspace_id,organization_id,kind,title,filename,object_key,source_url,byte_size,metadata,status) VALUES (${sourceId},${connector.knowledge_base_id},${connector.workspace_id},${connector.organization_id},'upload',${document.filename.slice(0, 200)},${document.filename},${key},${document.url},${bytes.length},${tx.json({ connectorId: connector.id, externalKey: document.key })},'queued')`;
          }
          await tx`INSERT INTO knowledge_jobs(id,source_id,knowledge_base_id,workspace_id,organization_id,source_revision,payload,status) VALUES (${randomUUID()},${sourceId},${connector.knowledge_base_id},${connector.workspace_id},${connector.organization_id},${revision},${tx.json({ objectKey: key, filename: document.filename })},'queued')`;
          await tx`INSERT INTO connector_items(connector_id,organization_id,workspace_id,external_key,source_id,fingerprint,last_seen_sync) VALUES (${connector.id},${connector.organization_id},${connector.workspace_id},${document.key},${sourceId},${document.fingerprint},${job.id}) ON CONFLICT(connector_id,external_key) DO UPDATE SET source_id=EXCLUDED.source_id,fingerprint=EXCLUDED.fingerprint,last_seen_sync=EXCLUDED.last_seen_sync`;
        });
      } catch (e) {
        await deleteKnowledge(key).catch(() => {});
        throw e;
      }
      if (item) counts.updated++;
      else counts.imported++;
    }
    signal.throwIfAborted();
    await authorize();
    await sql.begin(async (tx) => {
      await current(tx);
      const missing =
        await tx`SELECT source_id FROM connector_items WHERE connector_id=${connector.id} AND last_seen_sync<>${job.id}`;
      for (const item of missing) {
        await tx`UPDATE knowledge_sources SET status='deleted',revision=revision+1,updated_at=now() WHERE id=${item.source_id} AND status<>'deleted'`;
        await tx`UPDATE knowledge_jobs SET status='cancelled',finished_at=now() WHERE source_id=${item.source_id} AND status IN ('queued','running')`;
        await tx`DELETE FROM knowledge_documents WHERE source_id=${item.source_id}`;
        await tx`DELETE FROM connector_items WHERE connector_id=${connector.id} AND source_id=${item.source_id}`;
        counts.removed++;
      }
      await tx`UPDATE connector_syncs SET status='completed',counts=${tx.json(counts)},finished_at=now(),lease_token=NULL,lease_until=NULL WHERE id=${job.id} AND lease_token=${lease}`;
    });
  } catch (error) {
    await sql`UPDATE connector_syncs SET status='failed',error_code=${error instanceof ConnectorError ? error.code : signal.aborted ? "CONNECTOR_TIMEOUT" : "CONNECTOR_SYNC_FAILED"},counts=${sql.json(counts)},finished_at=now(),lease_token=NULL,lease_until=NULL WHERE id=${job.id} AND status='running' AND lease_token=${lease}`;
  } finally {
    clearInterval(heartbeat);
    controller.abort();
    adapter?.close();
  }
  return true;
}
