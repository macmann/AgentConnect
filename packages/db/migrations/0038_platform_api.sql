-- Extend the existing key registry; existing agent keys retain their scope.
ALTER TABLE workspace_api_keys ALTER COLUMN agent_id DROP NOT NULL;
ALTER TABLE workspace_api_keys ADD COLUMN knowledge_base_id uuid;
ALTER TABLE workspace_api_keys ADD COLUMN details_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE workspace_api_keys DROP CONSTRAINT workspace_api_keys_scope_check;
ALTER TABLE workspace_api_keys ADD CONSTRAINT workspace_api_keys_resource_scope CHECK (
 (scope IN ('agent:execute','agent:invoke') AND agent_id IS NOT NULL AND knowledge_base_id IS NULL) OR
 (scope='knowledge:search' AND knowledge_base_id IS NOT NULL AND agent_id IS NULL)
);
ALTER TABLE workspace_api_keys ADD FOREIGN KEY(knowledge_base_id,workspace_id,organization_id)
 REFERENCES knowledge_bases(id,workspace_id,organization_id);
ALTER TABLE conversations ADD COLUMN api_key_id uuid REFERENCES workspace_api_keys(id) ON DELETE SET NULL;
ALTER TABLE conversations DROP CONSTRAINT conversations_channel_check;
ALTER TABLE conversations ADD CONSTRAINT conversations_channel_check CHECK(channel IN ('playground','hosted','widget','messenger','viber','telegram','teams','api'));
CREATE INDEX conversations_api_key ON conversations(api_key_id) WHERE api_key_id IS NOT NULL;
