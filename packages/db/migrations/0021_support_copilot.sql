CREATE TABLE support_copilot (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, workspace_id uuid NOT NULL,
 conversation_id uuid NOT NULL, support_case_id uuid NOT NULL,
 requested_by uuid NOT NULL REFERENCES users(id),
 kind text NOT NULL CHECK(kind IN ('reply','summary','next_action','knowledge')),
 status text NOT NULL CHECK(status IN ('running','completed','failed')),
 context_hash text NOT NULL,
 result jsonb, citations jsonb NOT NULL DEFAULT '[]', tools jsonb NOT NULL DEFAULT '[]',
 provenance jsonb NOT NULL DEFAULT '{}', lease_until timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(support_case_id,conversation_id,workspace_id,organization_id)
 REFERENCES support_cases(id,conversation_id,workspace_id,organization_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX support_copilot_one_running ON support_copilot(support_case_id) WHERE status='running';
CREATE INDEX support_copilot_history ON support_copilot(support_case_id,created_at DESC,id DESC);
