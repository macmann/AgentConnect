CREATE TABLE mcp_connectors (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, workspace_id uuid NOT NULL,
 name text NOT NULL, url text NOT NULL, secret_id uuid, enabled boolean NOT NULL DEFAULT true,
 capabilities jsonb NOT NULL DEFAULT '{}'::jsonb, discovered_at timestamptz,
 revision integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,workspace_id,organization_id),
 FOREIGN KEY(workspace_id,organization_id) REFERENCES workspaces(id,organization_id),
 FOREIGN KEY(secret_id,workspace_id,organization_id) REFERENCES secrets(id,workspace_id,organization_id)
);
CREATE TABLE tools (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, workspace_id uuid NOT NULL,
 name text NOT NULL, description text NOT NULL, kind text NOT NULL CHECK(kind IN ('http','database','search','mcp')),
 config jsonb NOT NULL, input_schema jsonb NOT NULL, enabled boolean NOT NULL DEFAULT true,
 public_access boolean NOT NULL DEFAULT false, timeout_ms integer NOT NULL CHECK(timeout_ms BETWEEN 500 AND 15000),
 revision integer NOT NULL DEFAULT 1, archived_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,workspace_id,organization_id),
 FOREIGN KEY(workspace_id,organization_id) REFERENCES workspaces(id,organization_id)
);
CREATE TABLE tool_executions (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, workspace_id uuid NOT NULL, tool_id uuid NOT NULL,
 run_id uuid, user_id uuid REFERENCES users(id), tool_name text NOT NULL, tool_revision integer NOT NULL,
 arguments jsonb NOT NULL, result jsonb, status text NOT NULL CHECK(status IN ('running','completed','failed','cancelled')),
 error_code text, duration_ms integer, started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
 FOREIGN KEY(tool_id,workspace_id,organization_id) REFERENCES tools(id,workspace_id,organization_id),
 FOREIGN KEY(run_id,workspace_id,organization_id) REFERENCES agent_runs(id,workspace_id,organization_id)
);
CREATE INDEX tool_executions_workspace_time ON tool_executions(workspace_id,started_at DESC);
