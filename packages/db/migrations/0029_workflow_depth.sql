ALTER TABLE workflow_node_runs ADD COLUMN attempts integer NOT NULL DEFAULT 0 CHECK (attempts>=0);
ALTER TABLE workflow_node_runs ADD COLUMN retry_history jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE workflow_node_runs ADD COLUMN retry_at timestamptz;
