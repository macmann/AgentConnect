CREATE TABLE knowledge_processing_usage (
 id uuid PRIMARY KEY,
 source_id uuid NOT NULL, knowledge_base_id uuid NOT NULL,
 workspace_id uuid NOT NULL, organization_id uuid NOT NULL,
 job_id uuid NOT NULL REFERENCES knowledge_jobs(id) ON DELETE CASCADE,
 source_revision integer NOT NULL, attempt integer NOT NULL,
 stage text NOT NULL CHECK(stage IN ('vision','boundaries','correction')),
 page integer, model_id uuid, provider text, model_name text,
 status text NOT NULL CHECK(status IN ('running','completed','cached','reused','failed')),
 input_tokens integer, output_tokens integer,
 input_usd_per_million numeric(14,6), output_usd_per_million numeric(14,6),
 estimated_cost_usd numeric(20,10), duration_ms integer, error_code text,
 trace_id text NOT NULL, started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
 FOREIGN KEY(source_id,knowledge_base_id,workspace_id,organization_id) REFERENCES knowledge_sources(id,knowledge_base_id,workspace_id,organization_id) ON DELETE CASCADE
);
CREATE INDEX knowledge_processing_usage_source_time ON knowledge_processing_usage(source_id,started_at DESC);
ALTER TABLE tools DROP CONSTRAINT tools_kind_check;
ALTER TABLE tools ADD CONSTRAINT tools_kind_check CHECK(kind IN ('http','database','search','mcp','financial'));
