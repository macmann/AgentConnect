CREATE TABLE workflow_http_connections (
 id uuid PRIMARY KEY,workspace_id uuid NOT NULL,organization_id uuid NOT NULL,name text NOT NULL,base_url text NOT NULL,auth text NOT NULL CHECK(auth IN ('none','bearer','api-key','basic')),secret_id uuid,header_name text NOT NULL,methods jsonb NOT NULL,idempotency_supported boolean NOT NULL DEFAULT false,scopes jsonb NOT NULL DEFAULT '[]',enabled boolean NOT NULL DEFAULT true,revision integer NOT NULL DEFAULT 1,created_by uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,workspace_id,organization_id),FOREIGN KEY(workspace_id,organization_id) REFERENCES workspaces(id,organization_id),FOREIGN KEY(secret_id,workspace_id,organization_id) REFERENCES secrets(id,workspace_id,organization_id)
);
CREATE TABLE workflow_mcp_action_grants (
 id uuid PRIMARY KEY,workspace_id uuid NOT NULL,organization_id uuid NOT NULL,connector_id uuid NOT NULL,operation text NOT NULL,side_effect text NOT NULL CHECK(side_effect IN ('read','write','delete')),risk_level text NOT NULL CHECK(risk_level IN ('low','medium','high')),capability_hash text NOT NULL,metadata jsonb NOT NULL,idempotency_argument text,scopes jsonb NOT NULL DEFAULT '[]',enabled boolean NOT NULL DEFAULT true,created_by uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(connector_id,operation),FOREIGN KEY(connector_id,workspace_id,organization_id) REFERENCES mcp_connectors(id,workspace_id,organization_id) ON DELETE CASCADE
);
CREATE TABLE workflow_action_executions (
 id uuid PRIMARY KEY,run_id uuid NOT NULL,node_id text NOT NULL,workspace_id uuid NOT NULL,organization_id uuid NOT NULL,action_id text NOT NULL,connector text NOT NULL,operation text NOT NULL,connection_id uuid,side_effect text NOT NULL,risk_level text NOT NULL,idempotency text NOT NULL,input_fingerprint text NOT NULL,status text NOT NULL CHECK(status IN ('running','completed','failed','uncertain')),attempts integer NOT NULL DEFAULT 0,result jsonb,error_code text,duration_ms integer,created_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz,
 UNIQUE(run_id,node_id),FOREIGN KEY(run_id,workspace_id,organization_id) REFERENCES workflow_runs(id,workspace_id,organization_id) ON DELETE CASCADE
);
CREATE TABLE workflow_action_attempts (
 id uuid PRIMARY KEY,execution_id uuid NOT NULL REFERENCES workflow_action_executions(id) ON DELETE CASCADE,attempt integer NOT NULL,status text NOT NULL,error_code text,duration_ms integer,started_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz,UNIQUE(execution_id,attempt)
);
CREATE TABLE workflow_webhooks (
 id uuid PRIMARY KEY,workflow_id uuid NOT NULL,version_id uuid NOT NULL,workspace_id uuid NOT NULL,organization_id uuid NOT NULL,name text NOT NULL,token_hash text NOT NULL,expires_at timestamptz NOT NULL,input_schema jsonb NOT NULL DEFAULT '{}',sample jsonb NOT NULL DEFAULT '{}',enabled boolean NOT NULL DEFAULT true,created_by uuid NOT NULL REFERENCES users(id),revision integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(workflow_id,workspace_id,organization_id) REFERENCES workflows(id,workspace_id,organization_id),FOREIGN KEY(version_id,workflow_id,workspace_id,organization_id) REFERENCES workflow_versions(id,workflow_id,workspace_id,organization_id)
);
ALTER TABLE workflow_runs ADD COLUMN webhook_id uuid REFERENCES workflow_webhooks(id);
