ALTER TABLE messages ADD CONSTRAINT messages_tenant_identity UNIQUE(id,workspace_id,organization_id);
ALTER TABLE deployments ADD COLUMN environment text NOT NULL DEFAULT 'production' CHECK(environment IN ('development','staging','production'));
CREATE TABLE conversation_reviews (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL, organization_id uuid NOT NULL, message_id uuid NOT NULL,
 reviewer_id uuid NOT NULL REFERENCES users(id), rating text CHECK(rating IN ('like','dislike')), label text,
 comment text NOT NULL DEFAULT '', corrected_response text, reason text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(message_id,workspace_id,organization_id) REFERENCES messages(id,workspace_id,organization_id)
);
CREATE INDEX reviews_message_time ON conversation_reviews(message_id,created_at DESC);
CREATE TABLE model_prices (
 model_id uuid PRIMARY KEY, workspace_id uuid NOT NULL, organization_id uuid NOT NULL,
 input_usd_per_million numeric(14,6) NOT NULL CHECK(input_usd_per_million>=0), output_usd_per_million numeric(14,6) NOT NULL CHECK(output_usd_per_million>=0),
 updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL REFERENCES users(id),
 FOREIGN KEY(model_id,workspace_id,organization_id) REFERENCES model_configurations(id,workspace_id,organization_id)
);
ALTER TABLE agent_runs ADD COLUMN input_usd_per_million numeric(14,6);
ALTER TABLE agent_runs ADD COLUMN output_usd_per_million numeric(14,6);
CREATE TABLE workspace_api_keys (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL, organization_id uuid NOT NULL, agent_id uuid NOT NULL,
 label text NOT NULL, token_hash text NOT NULL UNIQUE, prefix text NOT NULL, created_by uuid NOT NULL REFERENCES users(id),
 scope text NOT NULL DEFAULT 'agent:execute' CHECK(scope='agent:execute'), expires_at timestamptz NOT NULL, revoked_at timestamptz, last_used_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(agent_id,workspace_id,organization_id) REFERENCES agents(id,workspace_id,organization_id)
);
CREATE TABLE workspace_webhooks (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL, organization_id uuid NOT NULL, name text NOT NULL, url text NOT NULL,
 signing_secret jsonb NOT NULL, enabled boolean NOT NULL DEFAULT true, created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,workspace_id,organization_id), FOREIGN KEY(workspace_id,organization_id) REFERENCES workspaces(id,organization_id)
);
CREATE TABLE webhook_deliveries (
 id uuid PRIMARY KEY, webhook_id uuid NOT NULL, workspace_id uuid NOT NULL, organization_id uuid NOT NULL, payload jsonb NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','delivered','failed')), attempts integer NOT NULL DEFAULT 0,
 next_attempt_at timestamptz NOT NULL DEFAULT now(), lease_until timestamptz, error_code text, http_status integer, created_at timestamptz NOT NULL DEFAULT now(), delivered_at timestamptz,
 FOREIGN KEY(webhook_id,workspace_id,organization_id) REFERENCES workspace_webhooks(id,workspace_id,organization_id)
);
CREATE INDEX webhook_deliveries_queue ON webhook_deliveries(status,next_attempt_at);
