-- Additive foundation. Existing handoff routes/events remain compatibility projections.
ALTER TABLE conversations ADD COLUMN conversation_mode text NOT NULL DEFAULT 'ai'
 CHECK(conversation_mode IN ('ai','waiting_human','human','returning_to_ai'));
ALTER TABLE conversations ADD COLUMN active_support_case_id uuid;
ALTER TABLE conversations ADD COLUMN last_customer_message_at timestamptz;
ALTER TABLE conversations ADD COLUMN last_agent_message_at timestamptz;
ALTER TABLE conversations ADD COLUMN last_human_message_at timestamptz;
CREATE TABLE support_queues (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, workspace_id uuid NOT NULL,
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 100), description text NOT NULL DEFAULT '',
 enabled boolean NOT NULL DEFAULT true, priority text NOT NULL DEFAULT 'normal' CHECK(priority IN ('low','normal','high','urgent')),
 routing_strategy text NOT NULL DEFAULT 'manual' CHECK(routing_strategy IN ('manual','round_robin','least_loaded','skill_based','hybrid')),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,workspace_id,organization_id),
 FOREIGN KEY(workspace_id,organization_id) REFERENCES workspaces(id,organization_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX support_queue_name ON support_queues(workspace_id,lower(name));
CREATE TABLE support_cases (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, workspace_id uuid NOT NULL, conversation_id uuid NOT NULL,
 status text NOT NULL CHECK(status IN ('requested','triaging','queued','assigned','active','waiting_customer','waiting_external','resolved','closed','cancelled')),
 reason_code text NOT NULL DEFAULT 'manual', reason_text text NOT NULL DEFAULT '', trigger_type text NOT NULL DEFAULT 'manual',
 priority text NOT NULL DEFAULT 'normal' CHECK(priority IN ('low','normal','high','urgent')),
 queue_id uuid, assigned_operator_id uuid REFERENCES users(id),
 resolution_code text, resolution_summary text, resume_context jsonb NOT NULL DEFAULT '{}',
 requested_at timestamptz NOT NULL DEFAULT now(), queued_at timestamptz, assigned_at timestamptz, accepted_at timestamptz,
 first_response_at timestamptz, resolved_at timestamptz, closed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 idempotency_key uuid,
 UNIQUE(id,workspace_id,organization_id), UNIQUE(id,conversation_id,workspace_id,organization_id),
 FOREIGN KEY(conversation_id,workspace_id,organization_id) REFERENCES conversations(id,workspace_id,organization_id) ON DELETE CASCADE,
 FOREIGN KEY(queue_id,workspace_id,organization_id) REFERENCES support_queues(id,workspace_id,organization_id)
);
CREATE UNIQUE INDEX support_one_open_case ON support_cases(conversation_id) WHERE status NOT IN ('resolved','closed','cancelled');
CREATE UNIQUE INDEX support_case_request_key ON support_cases(workspace_id,idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX support_case_list ON support_cases(workspace_id,created_at DESC,id DESC);
CREATE INDEX support_case_status ON support_cases(workspace_id,status,created_at DESC,id DESC);
CREATE INDEX support_case_queue ON support_cases(workspace_id,queue_id,status);
CREATE INDEX support_case_operator ON support_cases(workspace_id,assigned_operator_id,status);
CREATE INDEX support_case_conversation ON support_cases(conversation_id,created_at DESC);
CREATE TABLE support_events (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, workspace_id uuid NOT NULL,
 conversation_id uuid NOT NULL, support_case_id uuid NOT NULL,
 type text NOT NULL, actor_type text NOT NULL CHECK(actor_type IN ('system','customer','ai','operator','supervisor')),
 actor_id uuid REFERENCES users(id), payload jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(support_case_id,conversation_id,workspace_id,organization_id) REFERENCES support_cases(id,conversation_id,workspace_id,organization_id) ON DELETE CASCADE
);
CREATE INDEX support_event_timeline ON support_events(support_case_id,created_at DESC,id DESC);
CREATE TRIGGER support_event_activity AFTER INSERT ON support_events FOR EACH ROW EXECUTE FUNCTION touch_conversation_activity();
-- History is append-only during operations, but can be removed by authorized retention.
CREATE FUNCTION reject_support_event_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Support events are immutable'; END $$;
CREATE TRIGGER support_event_immutable BEFORE UPDATE ON support_events FOR EACH ROW EXECUTE FUNCTION reject_support_event_update();
-- Legacy data has no case boundaries. Preserve all events and represent its historical
-- thread as one case; every subsequent escalation creates a distinct case.
INSERT INTO support_cases(id,organization_id,workspace_id,conversation_id,status,trigger_type,reason_code,
 assigned_operator_id,created_at,requested_at,queued_at,accepted_at,resolved_at)
SELECT gen_random_uuid(),c.organization_id,c.workspace_id,c.id,
 CASE c.handoff_status WHEN 'pending' THEN 'queued' WHEN 'active' THEN 'active' ELSE 'resolved' END,
 'legacy','legacy_handoff',
 (SELECT actor_id FROM handoff_events e WHERE e.conversation_id=c.id AND kind='claimed' ORDER BY created_at DESC,id DESC LIMIT 1),
 COALESCE((SELECT min(created_at) FROM handoff_events e WHERE e.conversation_id=c.id),c.created_at),
 COALESCE((SELECT min(created_at) FROM handoff_events e WHERE e.conversation_id=c.id),c.created_at),
 (SELECT min(created_at) FROM handoff_events e WHERE e.conversation_id=c.id AND kind='requested'),
 (SELECT max(created_at) FROM handoff_events e WHERE e.conversation_id=c.id AND kind='claimed'),
 (SELECT max(created_at) FROM handoff_events e WHERE e.conversation_id=c.id AND kind='resolved')
FROM conversations c WHERE c.handoff_status<>'none';
INSERT INTO support_events(id,organization_id,workspace_id,conversation_id,support_case_id,type,actor_type,actor_id,payload,created_at)
SELECT e.id,e.organization_id,e.workspace_id,e.conversation_id,s.id,
 CASE e.kind WHEN 'requested' THEN 'case.created' WHEN 'claimed' THEN 'case.claimed' WHEN 'resolved' THEN 'case.resolved' ELSE 'message.created' END,
 CASE WHEN e.kind='user_message' OR e.kind='requested' THEN 'customer' ELSE 'operator' END,
 e.actor_id,jsonb_build_object('legacyKind',e.kind,'content',e.content),e.created_at
FROM handoff_events e JOIN support_cases s ON s.conversation_id=e.conversation_id;
UPDATE conversations c SET conversation_mode=CASE c.handoff_status WHEN 'pending' THEN 'waiting_human' WHEN 'active' THEN 'human' ELSE 'ai' END,
 active_support_case_id=CASE WHEN c.handoff_status IN ('pending','active') THEN s.id ELSE NULL END
FROM support_cases s WHERE s.conversation_id=c.id;
ALTER TABLE conversations ADD CONSTRAINT conversation_support_case
 FOREIGN KEY(active_support_case_id,id,workspace_id,organization_id) REFERENCES support_cases(id,conversation_id,workspace_id,organization_id) DEFERRABLE INITIALLY DEFERRED;
-- A users FK alone would allow assigning an operator from a different tenant.
-- Permission eligibility is evaluated by the shared RBAC service; this constraint
-- independently enforces membership at the assignment boundary.
CREATE FUNCTION support_assignee_membership() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.assigned_operator_id IS NOT NULL AND NOT EXISTS(
   SELECT 1 FROM memberships m WHERE m.user_id=NEW.assigned_operator_id
   AND m.organization_id=NEW.organization_id
   AND (m.workspace_id=NEW.workspace_id OR (m.workspace_id IS NULL AND m.role IN ('owner','org_admin')))
 ) THEN RAISE EXCEPTION 'Support assignee must belong to workspace' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER support_assignee_tenant BEFORE INSERT OR UPDATE OF assigned_operator_id,workspace_id,organization_id ON support_cases
 FOR EACH ROW EXECUTE FUNCTION support_assignee_membership();
UPDATE conversations c SET last_customer_message_at=(SELECT max(created_at) FROM messages m WHERE m.conversation_id=c.id AND m.role='user'),
 last_agent_message_at=(SELECT max(created_at) FROM messages m WHERE m.conversation_id=c.id AND m.role='assistant'),
 last_human_message_at=(SELECT max(created_at) FROM handoff_events e WHERE e.conversation_id=c.id AND e.kind='operator_message');
