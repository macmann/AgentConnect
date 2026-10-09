CREATE TABLE workflows (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, workspace_id uuid NOT NULL, name text NOT NULL,description text NOT NULL,
 draft_graph jsonb NOT NULL,revision integer NOT NULL DEFAULT 1,archived_at timestamptz,created_by uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,workspace_id,organization_id),FOREIGN KEY(workspace_id,organization_id) REFERENCES workspaces(id,organization_id)
);
CREATE TABLE workflow_versions (
 id uuid PRIMARY KEY,workflow_id uuid NOT NULL,workspace_id uuid NOT NULL,organization_id uuid NOT NULL,version integer NOT NULL,name text NOT NULL,graph jsonb NOT NULL,published_by uuid NOT NULL REFERENCES users(id),published_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workflow_id,version),UNIQUE(id,workflow_id,workspace_id,organization_id),FOREIGN KEY(workflow_id,workspace_id,organization_id) REFERENCES workflows(id,workspace_id,organization_id)
);
CREATE FUNCTION reject_workflow_version_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Published workflow versions are immutable'; END $$;
CREATE TRIGGER workflow_versions_immutable BEFORE UPDATE ON workflow_versions FOR EACH ROW EXECUTE FUNCTION reject_workflow_version_mutation();
CREATE TABLE workflow_runs (
 id uuid PRIMARY KEY,workflow_id uuid NOT NULL,version_id uuid,workspace_id uuid NOT NULL,organization_id uuid NOT NULL,user_id uuid NOT NULL REFERENCES users(id),graph_snapshot jsonb NOT NULL,input text NOT NULL,
 status text NOT NULL CHECK(status IN ('queued','running','waiting','completed','failed','cancelled','rejected')),output jsonb,error_code text,cancel_requested boolean NOT NULL DEFAULT false,
 lease_owner uuid,lease_expires_at timestamptz,attempts integer NOT NULL DEFAULT 0,created_at timestamptz NOT NULL DEFAULT now(),started_at timestamptz,finished_at timestamptz,
 UNIQUE(id,workspace_id,organization_id),FOREIGN KEY(workflow_id,workspace_id,organization_id) REFERENCES workflows(id,workspace_id,organization_id),FOREIGN KEY(version_id,workflow_id,workspace_id,organization_id) REFERENCES workflow_versions(id,workflow_id,workspace_id,organization_id)
);
CREATE INDEX workflow_runs_queue ON workflow_runs(status,created_at);
CREATE TABLE workflow_node_runs (
 run_id uuid NOT NULL,node_id text NOT NULL,workspace_id uuid NOT NULL,organization_id uuid NOT NULL,label text NOT NULL,kind text NOT NULL,status text NOT NULL CHECK(status IN ('running','completed','waiting','failed','cancelled')),input jsonb,output jsonb,error_code text,duration_ms integer,input_tokens integer,output_tokens integer,citations jsonb NOT NULL DEFAULT '[]'::jsonb,started_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz,
 PRIMARY KEY(run_id,node_id),FOREIGN KEY(run_id,workspace_id,organization_id) REFERENCES workflow_runs(id,workspace_id,organization_id)
);
CREATE TABLE workflow_approvals (
 id uuid PRIMARY KEY,run_id uuid NOT NULL,node_id text NOT NULL,workspace_id uuid NOT NULL,organization_id uuid NOT NULL,prompt text NOT NULL,input jsonb NOT NULL,decision text NOT NULL CHECK(decision IN ('pending','approved','rejected')),comment text NOT NULL DEFAULT '',edited_input jsonb,decided_by uuid REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),decided_at timestamptz,
 UNIQUE(run_id,node_id),FOREIGN KEY(run_id,workspace_id,organization_id) REFERENCES workflow_runs(id,workspace_id,organization_id)
);
ALTER TABLE tool_executions ADD COLUMN workflow_run_id uuid;
ALTER TABLE tool_executions ADD COLUMN workflow_node_id text;
ALTER TABLE tool_executions ADD CONSTRAINT tool_execution_workflow_tenant FOREIGN KEY(workflow_run_id,workspace_id,organization_id) REFERENCES workflow_runs(id,workspace_id,organization_id);
