-- Configured operators reuse existing users; no presence/profile is inferred from login.
CREATE TABLE operator_profiles (
 organization_id uuid NOT NULL, workspace_id uuid NOT NULL, user_id uuid NOT NULL REFERENCES users(id),
 enabled boolean NOT NULL DEFAULT true, manual_availability boolean NOT NULL DEFAULT true,
 capacity_limit integer NOT NULL DEFAULT 5 CHECK(capacity_limit BETWEEN 1 AND 100),
 priority_weight integer NOT NULL DEFAULT 1 CHECK(priority_weight BETWEEN 1 AND 10),
 timezone text NOT NULL DEFAULT 'UTC', languages jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(languages)='array'),
 presence_status text NOT NULL DEFAULT 'offline' CHECK(presence_status IN ('offline','available','busy','away','do_not_disturb')),
 presence_expires_at timestamptz, last_assigned_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,user_id), UNIQUE(workspace_id,user_id,organization_id),
 FOREIGN KEY(workspace_id,organization_id) REFERENCES workspaces(id,organization_id) ON DELETE CASCADE
);
CREATE TABLE support_skills (
 id uuid PRIMARY KEY,organization_id uuid NOT NULL,workspace_id uuid NOT NULL,
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 100),description text NOT NULL DEFAULT '',enabled boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,workspace_id,organization_id),
 FOREIGN KEY(workspace_id,organization_id) REFERENCES workspaces(id,organization_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX support_skill_name ON support_skills(workspace_id,lower(name));
CREATE TABLE operator_skills (
 organization_id uuid NOT NULL,workspace_id uuid NOT NULL,user_id uuid NOT NULL,skill_id uuid NOT NULL,
 proficiency integer NOT NULL CHECK(proficiency BETWEEN 1 AND 5),
 PRIMARY KEY(workspace_id,user_id,skill_id),
 FOREIGN KEY(workspace_id,user_id,organization_id) REFERENCES operator_profiles(workspace_id,user_id,organization_id) ON DELETE CASCADE,
 FOREIGN KEY(skill_id,workspace_id,organization_id) REFERENCES support_skills(id,workspace_id,organization_id) ON DELETE CASCADE
);
CREATE TABLE support_queue_members (
 organization_id uuid NOT NULL,workspace_id uuid NOT NULL,queue_id uuid NOT NULL,user_id uuid NOT NULL,
 enabled boolean NOT NULL DEFAULT true,priority_weight integer NOT NULL DEFAULT 1 CHECK(priority_weight BETWEEN 1 AND 10),
 last_assigned_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(queue_id,user_id),
 FOREIGN KEY(queue_id,workspace_id,organization_id) REFERENCES support_queues(id,workspace_id,organization_id) ON DELETE CASCADE,
 FOREIGN KEY(workspace_id,user_id,organization_id) REFERENCES operator_profiles(workspace_id,user_id,organization_id) ON DELETE CASCADE
);
ALTER TABLE support_queues ADD COLUMN assignment_mode text NOT NULL DEFAULT 'manual' CHECK(assignment_mode IN ('manual','recommend','automatic'));
ALTER TABLE support_queues ADD COLUMN is_default boolean NOT NULL DEFAULT false;
ALTER TABLE support_queues ADD COLUMN routing_config jsonb NOT NULL DEFAULT '{}';
CREATE UNIQUE INDEX support_default_queue ON support_queues(workspace_id) WHERE is_default;
ALTER TABLE support_cases ADD COLUMN routing_strategy text;
ALTER TABLE support_cases ADD COLUMN routing_score double precision;
ALTER TABLE support_cases ADD COLUMN routing_explanation jsonb NOT NULL DEFAULT '{}';
ALTER TABLE support_cases ADD COLUMN routing_next_attempt_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX support_routing_backlog ON support_cases(routing_next_attempt_at,queued_at,id) WHERE status='queued' AND queue_id IS NOT NULL;
