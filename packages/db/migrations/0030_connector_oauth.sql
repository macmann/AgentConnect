CREATE TABLE connector_oauth_attempts (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL, organization_id uuid NOT NULL,
 user_id uuid NOT NULL REFERENCES users(id), provider text NOT NULL,
 state_hash text NOT NULL UNIQUE, verifier jsonb NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','exchanging','connected','failed')),
 secret_id uuid REFERENCES secrets(id) ON DELETE SET NULL, error_code text,
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(workspace_id,organization_id) REFERENCES workspaces(id,organization_id)
);
CREATE INDEX connector_oauth_expiry ON connector_oauth_attempts(expires_at);
ALTER TABLE connector_syncs ADD COLUMN mode text NOT NULL DEFAULT 'incremental' CHECK(mode IN ('incremental','full'));
