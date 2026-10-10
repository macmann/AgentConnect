CREATE TABLE support_notes (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, workspace_id uuid NOT NULL,
 conversation_id uuid NOT NULL, support_case_id uuid NOT NULL,
 author_id uuid NOT NULL REFERENCES users(id), content text NOT NULL CHECK(length(content) BETWEEN 1 AND 4000),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(id,support_case_id,workspace_id,organization_id),
 FOREIGN KEY(support_case_id,conversation_id,workspace_id,organization_id)
 REFERENCES support_cases(id,conversation_id,workspace_id,organization_id) ON DELETE CASCADE
);
CREATE INDEX support_notes_case ON support_notes(support_case_id,created_at DESC,id DESC);
CREATE INDEX support_events_conversation ON support_events(conversation_id,created_at DESC,id DESC);
