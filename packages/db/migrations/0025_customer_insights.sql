ALTER TABLE deployments ADD COLUMN branding jsonb NOT NULL DEFAULT '{}';
CREATE TABLE customer_sessions (
 id uuid PRIMARY KEY, deployment_id uuid NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
 workspace_id uuid NOT NULL, organization_id uuid NOT NULL, token_hash text NOT NULL UNIQUE,
 channel text NOT NULL CHECK(channel IN ('hosted','widget')), widget_origin text,
 created_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL DEFAULT now()+interval '30 days',
 UNIQUE(id,workspace_id,organization_id),
 FOREIGN KEY(workspace_id,organization_id) REFERENCES workspaces(id,organization_id) ON DELETE CASCADE
);
ALTER TABLE conversations ADD COLUMN customer_session_id uuid;
ALTER TABLE conversations ADD CONSTRAINT conversations_customer_session_fk FOREIGN KEY(customer_session_id,workspace_id,organization_id) REFERENCES customer_sessions(id,workspace_id,organization_id) ON DELETE CASCADE;
CREATE INDEX customer_conversation_history ON conversations(customer_session_id,created_at DESC,id DESC);
ALTER TABLE conversations ADD COLUMN context_summary jsonb NOT NULL DEFAULT '{}';
ALTER TABLE agent_runs ADD COLUMN context_breakdown jsonb NOT NULL DEFAULT '{}';
CREATE TABLE customer_token_usage (
 workspace_id uuid NOT NULL, organization_id uuid NOT NULL, subject text NOT NULL, day date NOT NULL,
 used_tokens bigint NOT NULL DEFAULT 0 CHECK(used_tokens>=0), reserved_tokens bigint NOT NULL DEFAULT 0 CHECK(reserved_tokens>=0),
 PRIMARY KEY(workspace_id,subject,day),
 FOREIGN KEY(workspace_id,organization_id) REFERENCES workspaces(id,organization_id) ON DELETE CASCADE
);
CREATE TABLE token_reservations (
 run_id uuid PRIMARY KEY REFERENCES agent_runs(id) ON DELETE CASCADE,
 workspace_id uuid NOT NULL, subject text NOT NULL, day date NOT NULL, tokens bigint NOT NULL CHECK(tokens>0), settled boolean NOT NULL DEFAULT false,
 FOREIGN KEY(workspace_id,subject,day) REFERENCES customer_token_usage(workspace_id,subject,day) ON DELETE CASCADE
);
CREATE TABLE knowledge_improvements (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL, organization_id uuid NOT NULL,
 review_id uuid NOT NULL REFERENCES conversation_reviews(id) ON DELETE CASCADE,
 knowledge_base_id uuid NOT NULL, source_id uuid,
 question text NOT NULL, answer text NOT NULL, author_id uuid NOT NULL REFERENCES users(id), reviewer_id uuid REFERENCES users(id),
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','approved','rejected','materialized')),
 review_note text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(reviewer_id IS NULL OR reviewer_id<>author_id),
 UNIQUE(review_id,knowledge_base_id),
 FOREIGN KEY(knowledge_base_id,workspace_id,organization_id) REFERENCES knowledge_bases(id,workspace_id,organization_id) ON DELETE CASCADE,
 FOREIGN KEY(source_id,workspace_id,organization_id) REFERENCES knowledge_sources(id,workspace_id,organization_id) ON DELETE SET NULL (source_id)
);
CREATE TABLE operator_presence_samples (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, workspace_id uuid NOT NULL, organization_id uuid NOT NULL,
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, status text NOT NULL, expires_at timestamptz, recorded_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(workspace_id,user_id,organization_id) REFERENCES operator_profiles(workspace_id,user_id,organization_id) ON DELETE CASCADE
);
CREATE INDEX presence_report ON operator_presence_samples(workspace_id,user_id,recorded_at);
CREATE FUNCTION record_operator_presence() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO operator_presence_samples(workspace_id,organization_id,user_id,status,expires_at) VALUES(NEW.workspace_id,NEW.organization_id,NEW.user_id,NEW.presence_status,NEW.presence_expires_at); RETURN NEW;
END $$;
CREATE TRIGGER operator_presence_history AFTER INSERT OR UPDATE OF presence_status,presence_expires_at ON operator_profiles FOR EACH ROW EXECUTE FUNCTION record_operator_presence();
INSERT INTO operator_presence_samples(workspace_id,organization_id,user_id,status,expires_at) SELECT workspace_id,organization_id,user_id,presence_status,presence_expires_at FROM operator_profiles;
