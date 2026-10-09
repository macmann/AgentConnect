ALTER TABLE deployments ADD COLUMN widget_settings jsonb NOT NULL DEFAULT '{}';
ALTER TABLE conversations ADD COLUMN channel text NOT NULL DEFAULT 'hosted' CHECK(channel IN ('playground','hosted','widget'));
UPDATE conversations SET channel='playground' WHERE deployment_id IS NULL;
ALTER TABLE conversations ADD COLUMN widget_origin text;
ALTER TABLE conversations ADD COLUMN handoff_status text NOT NULL DEFAULT 'none' CHECK(handoff_status IN ('none','pending','active','resolved'));
CREATE TABLE handoff_events (
 id uuid PRIMARY KEY, conversation_id uuid NOT NULL, organization_id uuid NOT NULL, workspace_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('requested','claimed','user_message','operator_message','resolved')),
 content text NOT NULL DEFAULT '', actor_id uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(conversation_id,workspace_id,organization_id) REFERENCES conversations(id,workspace_id,organization_id)
);
CREATE INDEX handoffs_conversation ON handoff_events(conversation_id,created_at,id);
CREATE INDEX handoffs_workspace ON conversations(workspace_id,handoff_status,created_at);
