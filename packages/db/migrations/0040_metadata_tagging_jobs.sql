CREATE TABLE knowledge_metadata_jobs (
 id uuid PRIMARY KEY, source_id uuid NOT NULL, knowledge_base_id uuid NOT NULL,
 workspace_id uuid NOT NULL, organization_id uuid NOT NULL, requested_by uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 model_id uuid NOT NULL, source_revision integer NOT NULL, metadata_revision integer,
 status text NOT NULL CHECK(status IN ('queued','running','pending_review','applied','rejected','failed')),
 suggestion jsonb, error_code text, attempts integer NOT NULL DEFAULT 0, lease_token uuid, locked_until timestamptz,
 input_tokens integer, output_tokens integer, created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
 FOREIGN KEY(source_id,knowledge_base_id,workspace_id,organization_id) REFERENCES knowledge_sources(id,knowledge_base_id,workspace_id,organization_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX metadata_job_active ON knowledge_metadata_jobs(source_id) WHERE status IN ('queued','running','pending_review');
CREATE INDEX metadata_job_queue ON knowledge_metadata_jobs(status,created_at);
