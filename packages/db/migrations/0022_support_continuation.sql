ALTER TABLE conversations ADD COLUMN ai_resume_case_id uuid;
ALTER TABLE conversations ADD CONSTRAINT conversation_resume_case_scope
 FOREIGN KEY(ai_resume_case_id,id,workspace_id,organization_id)
 REFERENCES support_cases(id,conversation_id,workspace_id,organization_id) ON DELETE SET NULL (ai_resume_case_id);
ALTER TABLE support_copilot DROP CONSTRAINT support_copilot_kind_check;
ALTER TABLE support_copilot ADD CONSTRAINT support_copilot_kind_check CHECK(kind IN ('reply','summary','next_action','knowledge','resolution'));
CREATE INDEX support_resume_history ON support_cases(conversation_id,resolved_at DESC,id DESC) WHERE status IN ('resolved','closed');
