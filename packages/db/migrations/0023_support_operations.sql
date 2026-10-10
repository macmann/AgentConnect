ALTER TABLE support_queues ADD COLUMN operations_config jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(operations_config)='object');
ALTER TABLE support_queues ADD COLUMN fallback_queue_id uuid GENERATED ALWAYS AS ((operations_config->'businessHours'->>'fallbackQueueId')::uuid) STORED;
ALTER TABLE support_queues ADD CONSTRAINT support_fallback_scope FOREIGN KEY(fallback_queue_id,workspace_id,organization_id) REFERENCES support_queues(id,workspace_id,organization_id);
ALTER TABLE support_cases ADD COLUMN sla_snapshot jsonb NOT NULL DEFAULT '{}';
ALTER TABLE support_cases ADD COLUMN sla_state text NOT NULL DEFAULT 'on_track' CHECK(sla_state IN ('on_track','warning','breached'));
ALTER TABLE support_cases ADD COLUMN sla_details jsonb NOT NULL DEFAULT '{}';
ALTER TABLE support_cases ADD COLUMN sla_checked_at timestamptz;
ALTER TABLE support_cases ADD COLUMN operations_next_attempt_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE support_cases ADD COLUMN resolution_paused_at timestamptz;
ALTER TABLE support_cases ADD COLUMN resolution_paused_seconds double precision NOT NULL DEFAULT 0 CHECK(resolution_paused_seconds>=0);
ALTER TABLE support_cases ADD COLUMN first_assigned_at timestamptz;
ALTER TABLE support_cases ADD COLUMN first_accepted_at timestamptz;
ALTER TABLE support_cases ADD COLUMN acceptance_deadline timestamptz;
ALTER TABLE support_cases ADD COLUMN assignment_timeout_count integer NOT NULL DEFAULT 0 CHECK(assignment_timeout_count>=0);
ALTER TABLE support_cases ADD COLUMN timed_out_operator_ids uuid[] NOT NULL DEFAULT '{}';
ALTER TABLE support_cases ADD COLUMN reopen_count integer NOT NULL DEFAULT 0 CHECK(reopen_count>=0);
ALTER TABLE support_cases ADD COLUMN transfer_count integer NOT NULL DEFAULT 0 CHECK(transfer_count>=0);
UPDATE support_cases SET first_assigned_at=assigned_at,first_accepted_at=accepted_at;
CREATE INDEX support_operations_backlog ON support_cases(operations_next_attempt_at,id) WHERE status NOT IN ('closed','cancelled');
ALTER TABLE conversations ADD COLUMN support_revision bigint NOT NULL DEFAULT 0;
CREATE TABLE support_live_revisions (
 workspace_id uuid PRIMARY KEY,organization_id uuid NOT NULL,revision bigint NOT NULL DEFAULT 1,
 FOREIGN KEY(workspace_id,organization_id) REFERENCES workspaces(id,organization_id) ON DELETE CASCADE
);
CREATE FUNCTION touch_support_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='support_cases' AND TG_OP='UPDATE' THEN
  IF (to_jsonb(NEW)-ARRAY['operations_next_attempt_at','sla_checked_at','sla_details'])=(to_jsonb(OLD)-ARRAY['operations_next_attempt_at','sla_checked_at','sla_details']) THEN RETURN NEW; END IF;
 END IF;
 INSERT INTO support_live_revisions(workspace_id,organization_id) VALUES(NEW.workspace_id,NEW.organization_id)
 ON CONFLICT(workspace_id) DO UPDATE SET revision=support_live_revisions.revision+1;
 RETURN NEW;
END $$;
CREATE TRIGGER support_case_revision AFTER INSERT OR UPDATE ON support_cases FOR EACH ROW EXECUTE FUNCTION touch_support_revision();
CREATE TRIGGER support_queue_revision AFTER INSERT OR UPDATE ON support_queues FOR EACH ROW EXECUTE FUNCTION touch_support_revision();
CREATE TRIGGER support_operator_revision AFTER INSERT OR UPDATE ON operator_profiles FOR EACH ROW EXECUTE FUNCTION touch_support_revision();
CREATE FUNCTION support_case_clocks() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE paused boolean; was_paused boolean; cfg jsonb;
BEGIN
 IF TG_OP='INSERT' THEN
  SELECT operations_config INTO cfg FROM support_queues WHERE id=NEW.queue_id AND workspace_id=NEW.workspace_id;
  NEW.sla_snapshot=COALESCE(cfg,'{}');
 ELSE
  IF NEW.queue_id IS DISTINCT FROM OLD.queue_id AND OLD.first_assigned_at IS NULL AND NEW.transfer_count=0 THEN
   SELECT operations_config INTO cfg FROM support_queues WHERE id=NEW.queue_id AND workspace_id=NEW.workspace_id;
   NEW.sla_snapshot=COALESCE(cfg,'{}');
  END IF;
  IF NEW.status='active' AND OLD.status='resolved' THEN
   NEW.reopen_count=OLD.reopen_count+1;
   NEW.resolution_paused_seconds=OLD.resolution_paused_seconds+GREATEST(0,EXTRACT(EPOCH FROM clock_timestamp()-OLD.resolved_at));
  END IF;
 END IF;
 paused=(NEW.status='waiting_customer' AND COALESCE((NEW.sla_snapshot->'sla'->>'pauseWaitingCustomer')::boolean,true)) OR (NEW.status='waiting_external' AND COALESCE((NEW.sla_snapshot->'sla'->>'pauseWaitingExternal')::boolean,false));
 IF TG_OP='UPDATE' THEN
  was_paused=OLD.resolution_paused_at IS NOT NULL;
  IF was_paused AND NOT paused THEN
   NEW.resolution_paused_seconds=NEW.resolution_paused_seconds+GREATEST(0,EXTRACT(EPOCH FROM clock_timestamp()-OLD.resolution_paused_at));
   NEW.resolution_paused_at=NULL;
  END IF;
 END IF;
 IF paused AND NEW.resolution_paused_at IS NULL THEN NEW.resolution_paused_at=clock_timestamp(); END IF;
 IF NEW.status='assigned' AND (TG_OP='INSERT' OR NEW.assigned_at IS DISTINCT FROM OLD.assigned_at) THEN
  SELECT operations_config INTO cfg FROM support_queues WHERE id=NEW.queue_id AND workspace_id=NEW.workspace_id;
  NEW.acceptance_deadline=clock_timestamp()+make_interval(secs=>COALESCE((cfg->>'acceptanceTimeoutSeconds')::integer,120));
 END IF;
 IF NEW.status<>'assigned' THEN NEW.acceptance_deadline=NULL; END IF;
 NEW.first_assigned_at=COALESCE(NEW.first_assigned_at,NEW.assigned_at);
 NEW.first_accepted_at=COALESCE(NEW.first_accepted_at,NEW.accepted_at);
 RETURN NEW;
END $$;
CREATE TRIGGER support_case_clock BEFORE INSERT OR UPDATE ON support_cases FOR EACH ROW EXECUTE FUNCTION support_case_clocks();
CREATE TABLE support_notifications (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL,workspace_id uuid NOT NULL,
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,support_case_id uuid NOT NULL,event_id uuid NOT NULL REFERENCES support_events(id) ON DELETE CASCADE,
 kind text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),read_at timestamptz,
 UNIQUE(event_id,user_id),
 FOREIGN KEY(support_case_id,workspace_id,organization_id) REFERENCES support_cases(id,workspace_id,organization_id) ON DELETE CASCADE
);
CREATE INDEX support_notification_inbox ON support_notifications(workspace_id,user_id,created_at DESC,id DESC);
CREATE FUNCTION support_event_operations() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s support_cases;
BEGIN
 UPDATE conversations SET support_revision=support_revision+1 WHERE id=NEW.conversation_id AND workspace_id=NEW.workspace_id;
 PERFORM 1 FROM support_cases WHERE id=NEW.support_case_id;
 SELECT * INTO s FROM support_cases WHERE id=NEW.support_case_id;
 IF NEW.type IN ('case.created','case.assigned','case.transferred','sla.warning','sla.breached','assignment.expired') OR (NEW.type='message.created' AND NEW.actor_type='customer') THEN
  INSERT INTO support_notifications(organization_id,workspace_id,user_id,support_case_id,event_id,kind)
  SELECT NEW.organization_id,NEW.workspace_id,m.user_id,s.id,NEW.id,CASE WHEN NEW.type='message.created' THEN 'customer.replied' ELSE NEW.type END
  FROM memberships m WHERE m.organization_id=NEW.organization_id AND ((m.workspace_id IS NULL AND m.role IN ('owner','org_admin')) OR (m.workspace_id=NEW.workspace_id AND (m.role='workspace_admin' OR (m.role IN ('builder','operator') AND (m.user_id=s.assigned_operator_id OR (s.assigned_operator_id IS NULL AND (s.queue_id IS NULL OR EXISTS(SELECT 1 FROM support_queue_members qm WHERE qm.queue_id=s.queue_id AND qm.user_id=m.user_id AND qm.enabled))))))))
  GROUP BY m.user_id ON CONFLICT(event_id,user_id) DO NOTHING;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER support_event_ops AFTER INSERT ON support_events FOR EACH ROW EXECUTE FUNCTION support_event_operations();
