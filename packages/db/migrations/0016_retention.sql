ALTER TABLE conversations ADD COLUMN last_activity_at timestamptz NOT NULL DEFAULT now();
UPDATE conversations c SET last_activity_at=GREATEST(c.created_at,
 COALESCE((SELECT max(created_at) FROM messages WHERE conversation_id=c.id),c.created_at),
 COALESCE((SELECT max(GREATEST(started_at,finished_at)) FROM agent_runs WHERE conversation_id=c.id),c.created_at),
 COALESCE((SELECT max(created_at) FROM handoff_events WHERE conversation_id=c.id),c.created_at));
CREATE FUNCTION touch_conversation_activity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 UPDATE conversations SET last_activity_at=GREATEST(last_activity_at,now()) WHERE id=NEW.conversation_id;
 RETURN NEW;
END $$;
CREATE TRIGGER message_activity AFTER INSERT ON messages FOR EACH ROW EXECUTE FUNCTION touch_conversation_activity();
CREATE TRIGGER run_activity AFTER INSERT OR UPDATE ON agent_runs FOR EACH ROW EXECUTE FUNCTION touch_conversation_activity();
CREATE TRIGGER handoff_activity AFTER INSERT ON handoff_events FOR EACH ROW EXECUTE FUNCTION touch_conversation_activity();
CREATE INDEX conversations_retention ON conversations(workspace_id,last_activity_at);
CREATE INDEX agent_runs_retention ON agent_runs(workspace_id,finished_at);
CREATE INDEX workflow_runs_retention ON workflow_runs(workspace_id,finished_at);
CREATE INDEX artifacts_retention ON generated_artifacts(workspace_id,created_at);
CREATE INDEX connector_syncs_retention ON connector_syncs(workspace_id,finished_at);

CREATE TABLE workspace_retention (
 workspace_id uuid PRIMARY KEY, organization_id uuid NOT NULL,
 enabled boolean NOT NULL DEFAULT false, revision integer NOT NULL DEFAULT 1,
 conversation_days integer CHECK(conversation_days BETWEEN 1 AND 36500),
 run_days integer CHECK(run_days BETWEEN 1 AND 36500),
 artifact_days integer CHECK(artifact_days BETWEEN 1 AND 36500),
 connector_days integer CHECK(connector_days BETWEEN 1 AND 36500),
 updated_by uuid NOT NULL REFERENCES users(id), updated_at timestamptz NOT NULL DEFAULT now(), next_run_at timestamptz,
 FOREIGN KEY(workspace_id,organization_id) REFERENCES workspaces(id,organization_id)
);
CREATE TABLE retention_runs (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL, organization_id uuid NOT NULL,
 policy_revision integer NOT NULL, requested_by uuid NOT NULL REFERENCES users(id),
 trigger_kind text NOT NULL CHECK(trigger_kind IN ('manual','scheduled')),
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','completed','failed','cancelled')),
 counts jsonb NOT NULL DEFAULT '{}', error_code text, created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
 FOREIGN KEY(workspace_id,organization_id) REFERENCES workspaces(id,organization_id)
);
CREATE UNIQUE INDEX retention_one_queued ON retention_runs(workspace_id) WHERE status='queued';
CREATE INDEX retention_runs_history ON retention_runs(workspace_id,created_at DESC);
CREATE TABLE retention_object_deletions (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL, organization_id uuid NOT NULL,
 storage_key text NOT NULL UNIQUE, attempts integer NOT NULL DEFAULT 0,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','blocked')),
 next_attempt_at timestamptz NOT NULL DEFAULT now(), error_code text, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(workspace_id,organization_id) REFERENCES workspaces(id,organization_id)
);
CREATE INDEX retention_objects_due ON retention_object_deletions(status,next_attempt_at);
