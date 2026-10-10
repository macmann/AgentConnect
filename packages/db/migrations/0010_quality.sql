CREATE TABLE evaluation_datasets (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, workspace_id uuid NOT NULL, name text NOT NULL,description text NOT NULL,
 examples jsonb NOT NULL DEFAULT '[]',revision integer NOT NULL DEFAULT 1, archived_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,workspace_id,organization_id), FOREIGN KEY(workspace_id,organization_id) REFERENCES workspaces(id,organization_id)
);
CREATE TABLE evaluation_runs (
 id uuid PRIMARY KEY,organization_id uuid NOT NULL,workspace_id uuid NOT NULL,agent_id uuid NOT NULL,dataset_id uuid NOT NULL,requested_by uuid NOT NULL REFERENCES users(id),
 agent_revision integer NOT NULL,dataset_revision integer NOT NULL,config_snapshot jsonb NOT NULL,model_snapshot jsonb NOT NULL,examples_snapshot jsonb NOT NULL,
 evaluator jsonb NOT NULL,judge_snapshot jsonb,prices_snapshot jsonb NOT NULL DEFAULT '{}',fingerprint text NOT NULL,baseline_run_id uuid REFERENCES evaluation_runs(id),
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','completed','failed','cancelled')),summary jsonb,error_code text,
 attempts integer NOT NULL DEFAULT 0,lease_token uuid,lease_until timestamptz,created_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz,
 UNIQUE(id,workspace_id,organization_id), FOREIGN KEY(agent_id,workspace_id,organization_id) REFERENCES agents(id,workspace_id,organization_id),
 FOREIGN KEY(dataset_id,workspace_id,organization_id) REFERENCES evaluation_datasets(id,workspace_id,organization_id)
);
CREATE INDEX evaluation_claim ON evaluation_runs(status,lease_until,created_at);
CREATE TABLE evaluation_results (
 id uuid PRIMARY KEY,run_id uuid NOT NULL,organization_id uuid NOT NULL,workspace_id uuid NOT NULL,example_id uuid NOT NULL,
 status text NOT NULL CHECK(status IN ('completed','failed')),output text NOT NULL,score double precision,passed boolean NOT NULL,
 metrics jsonb NOT NULL,error_code text,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(run_id,example_id),
 FOREIGN KEY(run_id,workspace_id,organization_id) REFERENCES evaluation_runs(id,workspace_id,organization_id)
);
CREATE TABLE agent_quality_gates (
 agent_id uuid PRIMARY KEY,organization_id uuid NOT NULL,workspace_id uuid NOT NULL,settings jsonb NOT NULL,updated_by uuid NOT NULL REFERENCES users(id),updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(agent_id,workspace_id,organization_id) REFERENCES agents(id,workspace_id,organization_id)
);
