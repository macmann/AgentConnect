ALTER TABLE knowledge_gap_assignments ADD COLUMN clustering_metadata jsonb NOT NULL DEFAULT '{}';
CREATE TABLE knowledge_gap_previews (
 id uuid PRIMARY KEY,workspace_id uuid NOT NULL,organization_id uuid NOT NULL,
 created_by uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 model_id uuid NOT NULL,model_name text NOT NULL,threshold double precision NOT NULL,
 range_from timestamptz NOT NULL,range_to timestamptz NOT NULL,
 proposals jsonb NOT NULL,snapshot_hash text NOT NULL,
 run_ids jsonb NOT NULL,protected_count integer NOT NULL,truncated boolean NOT NULL,
 applied_groups jsonb NOT NULL DEFAULT '[]',
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','applied')),
 created_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL DEFAULT now()+interval '10 minutes',
 FOREIGN KEY(workspace_id,organization_id) REFERENCES workspaces(id,organization_id) ON DELETE CASCADE
);
CREATE INDEX knowledge_gap_previews_expiry ON knowledge_gap_previews(workspace_id,expires_at);
