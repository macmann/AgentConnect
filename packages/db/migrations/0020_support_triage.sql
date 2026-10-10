CREATE TABLE support_policies (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, workspace_id uuid NOT NULL,
 scope text NOT NULL CHECK(scope IN ('workspace','agent','deployment')), target_id uuid NOT NULL,
 policy jsonb NOT NULL, revision integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,scope,target_id),
 FOREIGN KEY(workspace_id,organization_id) REFERENCES workspaces(id,organization_id) ON DELETE CASCADE
);
-- Agent/deployment scope is checked at the database boundary as well as in the service.
CREATE FUNCTION support_policy_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.scope='workspace' AND NEW.target_id<>NEW.workspace_id)
 OR (NEW.scope='agent' AND NOT EXISTS(SELECT 1 FROM agents WHERE id=NEW.target_id AND workspace_id=NEW.workspace_id AND organization_id=NEW.organization_id))
 OR (NEW.scope='deployment' AND NOT EXISTS(SELECT 1 FROM deployments WHERE id=NEW.target_id AND workspace_id=NEW.workspace_id AND organization_id=NEW.organization_id))
 THEN RAISE EXCEPTION 'Support policy target must belong to workspace' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER support_policy_scope_guard BEFORE INSERT OR UPDATE ON support_policies FOR EACH ROW EXECUTE FUNCTION support_policy_scope();
CREATE TABLE support_offers (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, workspace_id uuid NOT NULL, conversation_id uuid NOT NULL,
 status text NOT NULL DEFAULT 'offered' CHECK(status IN ('offered','dismissed','confirmed','expired')),
 reason_code text NOT NULL, policy_snapshot jsonb NOT NULL, signals jsonb NOT NULL DEFAULT '{}',
 decided_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL DEFAULT now()+interval '30 minutes',
 FOREIGN KEY(conversation_id,workspace_id,organization_id) REFERENCES conversations(id,workspace_id,organization_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX support_one_offer ON support_offers(conversation_id) WHERE status='offered';
CREATE TABLE support_decisions (
 run_id uuid PRIMARY KEY,
 organization_id uuid NOT NULL, workspace_id uuid NOT NULL, conversation_id uuid NOT NULL,
 signals jsonb NOT NULL, reason_code text, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(run_id,workspace_id,organization_id) REFERENCES agent_runs(id,workspace_id,organization_id) ON DELETE CASCADE,
 FOREIGN KEY(conversation_id,workspace_id,organization_id) REFERENCES conversations(id,workspace_id,organization_id) ON DELETE CASCADE
);
ALTER TABLE support_cases ADD COLUMN policy_snapshot jsonb NOT NULL DEFAULT '{}';
ALTER TABLE support_cases ADD COLUMN triage_status text NOT NULL DEFAULT 'none' CHECK(triage_status IN ('none','pending','running','completed','failed'));
ALTER TABLE support_cases ADD COLUMN triage_result jsonb NOT NULL DEFAULT '{}';
ALTER TABLE support_cases ADD COLUMN handoff_brief jsonb NOT NULL DEFAULT '{}';
ALTER TABLE support_cases ADD COLUMN triage_provenance jsonb NOT NULL DEFAULT '{}';
ALTER TABLE support_cases ADD COLUMN triage_lease_token uuid;
ALTER TABLE support_cases ADD COLUMN triage_lease_until timestamptz;
ALTER TABLE support_cases ADD COLUMN routing_requirements jsonb NOT NULL DEFAULT '{}';
CREATE INDEX support_triage_jobs ON support_cases(created_at,id) WHERE triage_status IN ('pending','running');
