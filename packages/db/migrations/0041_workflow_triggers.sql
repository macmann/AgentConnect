ALTER TABLE workspace_api_keys ADD COLUMN workflow_id uuid;
ALTER TABLE workspace_api_keys ADD CONSTRAINT workspace_api_keys_workflow_tenant FOREIGN KEY(workflow_id,workspace_id,organization_id) REFERENCES workflows(id,workspace_id,organization_id);
ALTER TABLE workspace_api_keys DROP CONSTRAINT workspace_api_keys_resource_scope;
ALTER TABLE workspace_api_keys ADD CONSTRAINT workspace_api_keys_resource_scope CHECK (
 (scope IN ('agent:execute','agent:invoke') AND agent_id IS NOT NULL AND knowledge_base_id IS NULL AND workflow_id IS NULL) OR
 (scope='knowledge:search' AND knowledge_base_id IS NOT NULL AND agent_id IS NULL AND workflow_id IS NULL) OR
 (scope='workflow:execute' AND workflow_id IS NOT NULL AND agent_id IS NULL AND knowledge_base_id IS NULL)
);
CREATE TABLE workflow_schedules (
 id uuid PRIMARY KEY,workflow_id uuid NOT NULL,workspace_id uuid NOT NULL,organization_id uuid NOT NULL,
 version_id uuid NOT NULL,name text NOT NULL,cron text NOT NULL,timezone text NOT NULL,input text NOT NULL,
 enabled boolean NOT NULL DEFAULT true,overlap_policy text NOT NULL CHECK(overlap_policy IN ('skip','allow')),
 missed_policy text NOT NULL CHECK(missed_policy IN ('skip','run_once')),created_by uuid NOT NULL REFERENCES users(id),
 revision integer NOT NULL DEFAULT 1,next_run_at timestamptz NOT NULL,last_run_at timestamptz,last_error text,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,workflow_id,workspace_id,organization_id),
 FOREIGN KEY(workflow_id,workspace_id,organization_id) REFERENCES workflows(id,workspace_id,organization_id),
 FOREIGN KEY(version_id,workflow_id,workspace_id,organization_id) REFERENCES workflow_versions(id,workflow_id,workspace_id,organization_id)
);
CREATE INDEX workflow_schedules_due ON workflow_schedules(next_run_at) WHERE enabled;
ALTER TABLE workflow_runs ADD COLUMN api_key_id uuid REFERENCES workspace_api_keys(id);
ALTER TABLE workflow_runs ADD COLUMN idempotency_key text;
ALTER TABLE workflow_runs ADD COLUMN request_fingerprint text;
ALTER TABLE workflow_runs ADD COLUMN schedule_id uuid REFERENCES workflow_schedules(id);
ALTER TABLE workflow_runs ADD COLUMN scheduled_for timestamptz;
CREATE UNIQUE INDEX workflow_runs_api_idempotency ON workflow_runs(api_key_id,idempotency_key) WHERE api_key_id IS NOT NULL;
CREATE UNIQUE INDEX workflow_runs_schedule_occurrence ON workflow_runs(schedule_id,scheduled_for) WHERE schedule_id IS NOT NULL;
CREATE INDEX workflow_runs_schedule_active ON workflow_runs(schedule_id,status);
