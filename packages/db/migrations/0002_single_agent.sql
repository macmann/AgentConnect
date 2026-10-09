ALTER TABLE secrets ADD CONSTRAINT secrets_tenant_identity UNIQUE(id,workspace_id,organization_id);
CREATE TABLE model_configurations (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, workspace_id uuid NOT NULL,
 name text NOT NULL, provider text NOT NULL CHECK(provider IN ('openai','openai-compatible','anthropic','gemini')),
 model_id text NOT NULL, base_url text NOT NULL, secret_id uuid,
 context_window integer NOT NULL CHECK(context_window>=256), max_output_tokens integer NOT NULL CHECK(max_output_tokens>0),
 capabilities jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,workspace_id,organization_id),
 FOREIGN KEY(workspace_id,organization_id) REFERENCES workspaces(id,organization_id),
 FOREIGN KEY(secret_id,workspace_id,organization_id) REFERENCES secrets(id,workspace_id,organization_id)
);
CREATE TABLE agents (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, workspace_id uuid NOT NULL,
 name text NOT NULL, description text NOT NULL, public_description text NOT NULL, draft_config jsonb NOT NULL,
 revision integer NOT NULL DEFAULT 1, archived_at timestamptz, created_by uuid NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,workspace_id,organization_id), FOREIGN KEY(workspace_id,organization_id) REFERENCES workspaces(id,organization_id)
);
CREATE TABLE agent_versions (
 id uuid PRIMARY KEY, agent_id uuid NOT NULL, workspace_id uuid NOT NULL, organization_id uuid NOT NULL,
 version integer NOT NULL CHECK(version>0), name text NOT NULL, public_description text NOT NULL,
 config jsonb NOT NULL, model_snapshot jsonb NOT NULL, model_id uuid NOT NULL,
 published_by uuid NOT NULL REFERENCES users(id), published_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(agent_id,version), UNIQUE(id,agent_id,workspace_id,organization_id),
 FOREIGN KEY(agent_id,workspace_id,organization_id) REFERENCES agents(id,workspace_id,organization_id),
 FOREIGN KEY(model_id,workspace_id,organization_id) REFERENCES model_configurations(id,workspace_id,organization_id)
);
CREATE FUNCTION immutable_agent_version() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Published agent versions are immutable'; END $$;
CREATE TRIGGER agent_version_immutable BEFORE UPDATE ON agent_versions FOR EACH ROW EXECUTE FUNCTION immutable_agent_version();
CREATE TABLE deployments (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, workspace_id uuid NOT NULL, agent_id uuid NOT NULL, version_id uuid NOT NULL,
 name text NOT NULL, enabled boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(version_id,agent_id,workspace_id,organization_id) REFERENCES agent_versions(id,agent_id,workspace_id,organization_id),
 UNIQUE(id,agent_id,workspace_id,organization_id)
);
CREATE TABLE conversations (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, workspace_id uuid NOT NULL, agent_id uuid NOT NULL,
 version_id uuid, deployment_id uuid, user_id uuid REFERENCES users(id), guest_token_hash text,
 config_snapshot jsonb NOT NULL, model_snapshot jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,workspace_id,organization_id), CHECK((user_id IS NOT NULL AND guest_token_hash IS NULL AND deployment_id IS NULL) OR (user_id IS NULL AND guest_token_hash IS NOT NULL AND deployment_id IS NOT NULL)),
 FOREIGN KEY(agent_id,workspace_id,organization_id) REFERENCES agents(id,workspace_id,organization_id),
 FOREIGN KEY(version_id,agent_id,workspace_id,organization_id) REFERENCES agent_versions(id,agent_id,workspace_id,organization_id),
 FOREIGN KEY(deployment_id,agent_id,workspace_id,organization_id) REFERENCES deployments(id,agent_id,workspace_id,organization_id)
);
CREATE TABLE agent_runs (
 id uuid PRIMARY KEY, conversation_id uuid NOT NULL, organization_id uuid NOT NULL, workspace_id uuid NOT NULL,
 status text NOT NULL CHECK(status IN ('running','completed','failed','cancelled')), trace_id text NOT NULL,
 input_tokens integer, output_tokens integer, error_code text, started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
 FOREIGN KEY(conversation_id,workspace_id,organization_id) REFERENCES conversations(id,workspace_id,organization_id), UNIQUE(id,workspace_id,organization_id)
);
CREATE UNIQUE INDEX conversation_one_running ON agent_runs(conversation_id) WHERE status='running';
CREATE TABLE messages (
 id uuid PRIMARY KEY, conversation_id uuid NOT NULL, organization_id uuid NOT NULL, workspace_id uuid NOT NULL,
 run_id uuid NOT NULL, role text NOT NULL CHECK(role IN ('user','assistant')), content text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(conversation_id,workspace_id,organization_id) REFERENCES conversations(id,workspace_id,organization_id),
 FOREIGN KEY(run_id,workspace_id,organization_id) REFERENCES agent_runs(id,workspace_id,organization_id)
);
CREATE INDEX conversations_tenant_time ON conversations(workspace_id,created_at DESC,id);
CREATE INDEX messages_conversation_time ON messages(conversation_id,created_at,id);
