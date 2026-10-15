CREATE TABLE knowledge_extraction_edits (
 id uuid PRIMARY KEY,
 source_id uuid NOT NULL,
 knowledge_base_id uuid NOT NULL,
 workspace_id uuid NOT NULL,
 organization_id uuid NOT NULL,
 source_revision integer NOT NULL CHECK(source_revision>0),
 artifact_key text NOT NULL,
 input_hash text NOT NULL,
 created_by uuid REFERENCES users(id) ON DELETE SET NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(source_id,source_revision),
 FOREIGN KEY(source_id,knowledge_base_id,workspace_id,organization_id) REFERENCES knowledge_sources(id,knowledge_base_id,workspace_id,organization_id) ON DELETE CASCADE,
 FOREIGN KEY(workspace_id,organization_id) REFERENCES workspaces(id,organization_id)
);
ALTER TABLE evaluation_runs ADD COLUMN document_snapshots jsonb NOT NULL DEFAULT '[]';
