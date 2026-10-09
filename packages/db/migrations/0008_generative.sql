ALTER TABLE messages ADD COLUMN ui_blocks jsonb NOT NULL DEFAULT '[]'::jsonb;
CREATE TABLE generated_artifacts (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, workspace_id uuid NOT NULL, message_id uuid NOT NULL,
 name text NOT NULL, content_type text NOT NULL, storage_key text NOT NULL UNIQUE, byte_size integer NOT NULL CHECK(byte_size>0 AND byte_size<=500000), created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(message_id,workspace_id,organization_id) REFERENCES messages(id,workspace_id,organization_id)
);
CREATE TABLE collected_submissions (
 id uuid PRIMARY KEY,organization_id uuid NOT NULL,workspace_id uuid NOT NULL,message_id uuid NOT NULL,conversation_id uuid NOT NULL,block_id text NOT NULL,
 values jsonb NOT NULL, submitted_by uuid REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(message_id,block_id),
 FOREIGN KEY(message_id,workspace_id,organization_id) REFERENCES messages(id,workspace_id,organization_id),
 FOREIGN KEY(conversation_id,workspace_id,organization_id) REFERENCES conversations(id,workspace_id,organization_id)
);
CREATE INDEX collected_workspace_time ON collected_submissions(workspace_id,created_at DESC,id);
