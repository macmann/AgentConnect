ALTER TABLE workflow_runs ADD COLUMN parent_run_id uuid;
ALTER TABLE workflow_runs ADD COLUMN parent_node_id text;
ALTER TABLE workflow_runs ADD COLUMN iteration_index integer;
ALTER TABLE workflow_runs ADD CONSTRAINT workflow_parent_tenant FOREIGN KEY(parent_run_id,workspace_id,organization_id) REFERENCES workflow_runs(id,workspace_id,organization_id) ON DELETE CASCADE;
ALTER TABLE workflow_runs ADD CONSTRAINT workflow_parent_shape CHECK ((parent_run_id IS NULL AND parent_node_id IS NULL AND iteration_index IS NULL) OR (parent_run_id IS NOT NULL AND parent_node_id IS NOT NULL AND iteration_index IS NOT NULL AND iteration_index BETWEEN 0 AND 99));
CREATE UNIQUE INDEX workflow_child_identity ON workflow_runs(parent_run_id,parent_node_id,iteration_index) WHERE parent_run_id IS NOT NULL;
CREATE TABLE workflow_suspensions (
 id uuid PRIMARY KEY, run_id uuid NOT NULL, node_id text NOT NULL, workspace_id uuid NOT NULL, organization_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('wait','event','children')),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','ready','cancelled')),
 due_at timestamptz, token_hash text, payload jsonb NOT NULL DEFAULT '{}', result jsonb, error_code text,
 created_at timestamptz NOT NULL DEFAULT now(), resumed_at timestamptz,
 UNIQUE(run_id,node_id), FOREIGN KEY(run_id,workspace_id,organization_id) REFERENCES workflow_runs(id,workspace_id,organization_id) ON DELETE CASCADE
);
CREATE INDEX workflow_suspensions_due ON workflow_suspensions(due_at) WHERE status='pending';
CREATE INDEX workflow_suspensions_active ON workflow_suspensions(run_id,status);
