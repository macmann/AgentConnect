ALTER TABLE knowledge_sources ADD CONSTRAINT knowledge_sources_tenant_identity UNIQUE(id,workspace_id,organization_id);
CREATE TABLE enterprise_connectors (
 id uuid PRIMARY KEY,organization_id uuid NOT NULL,workspace_id uuid NOT NULL,name text NOT NULL,kind text NOT NULL CHECK(kind='s3'),knowledge_base_id uuid NOT NULL,secret_id uuid,
 selection jsonb NOT NULL,enabled boolean NOT NULL DEFAULT true,revision integer NOT NULL DEFAULT 1,schedule_minutes integer CHECK(schedule_minutes BETWEEN 15 AND 10080),next_sync_at timestamptz,created_by uuid NOT NULL REFERENCES users(id),updated_by uuid NOT NULL REFERENCES users(id),archived_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,workspace_id,organization_id),FOREIGN KEY(workspace_id,organization_id) REFERENCES workspaces(id,organization_id),FOREIGN KEY(knowledge_base_id,workspace_id,organization_id) REFERENCES knowledge_bases(id,workspace_id,organization_id),FOREIGN KEY(secret_id,workspace_id,organization_id) REFERENCES secrets(id,workspace_id,organization_id)
);
CREATE TABLE connector_syncs (
 id uuid PRIMARY KEY,connector_id uuid NOT NULL,organization_id uuid NOT NULL,workspace_id uuid NOT NULL,requested_by uuid NOT NULL REFERENCES users(id),connector_revision integer NOT NULL,
 status text NOT NULL CHECK(status IN ('queued','running','completed','failed','cancelled')),attempts integer NOT NULL DEFAULT 0,lease_token uuid,lease_until timestamptz,counts jsonb NOT NULL DEFAULT '{}',error_code text,created_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz,
 UNIQUE(id,workspace_id,organization_id),FOREIGN KEY(connector_id,workspace_id,organization_id) REFERENCES enterprise_connectors(id,workspace_id,organization_id)
);
CREATE UNIQUE INDEX connector_one_pending ON connector_syncs(connector_id) WHERE status IN ('queued','running');
CREATE INDEX connector_sync_claim ON connector_syncs(status,lease_until,created_at);
CREATE INDEX connector_workspace ON enterprise_connectors(workspace_id,created_at);
CREATE TABLE connector_items (
 connector_id uuid NOT NULL,organization_id uuid NOT NULL,workspace_id uuid NOT NULL,external_key text NOT NULL,source_id uuid NOT NULL,fingerprint text NOT NULL,last_seen_sync uuid NOT NULL,
 PRIMARY KEY(connector_id,external_key),FOREIGN KEY(connector_id,workspace_id,organization_id) REFERENCES enterprise_connectors(id,workspace_id,organization_id),FOREIGN KEY(source_id,workspace_id,organization_id) REFERENCES knowledge_sources(id,workspace_id,organization_id)
);
