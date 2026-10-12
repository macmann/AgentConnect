-- Answer-specific reports reuse conversation reviews and knowledge improvements.
CREATE TABLE answer_issues (
 id uuid PRIMARY KEY, message_id uuid NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
 workspace_id uuid NOT NULL, organization_id uuid NOT NULL,
 reason text NOT NULL CHECK(reason IN ('incorrect','not_helpful','unresolved')), comment text NOT NULL DEFAULT '',
 status text NOT NULL DEFAULT 'reported' CHECK(status IN ('reported','reviewing','fix_ready','verified','closed')),
 assigned_to uuid REFERENCES users(id), revision integer NOT NULL DEFAULT 1,
 review_id uuid REFERENCES conversation_reviews(id) ON DELETE SET NULL,
 verification_release_id uuid REFERENCES knowledge_releases(id) ON DELETE SET NULL,
 resolution text CHECK(resolution IN ('corrected','dismissed')),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,workspace_id,organization_id),
 FOREIGN KEY(workspace_id,organization_id) REFERENCES workspaces(id,organization_id)
);
CREATE INDEX answer_issues_queue ON answer_issues(workspace_id,status,updated_at DESC,id);
CREATE TABLE answer_issue_events (
 id uuid PRIMARY KEY, issue_id uuid NOT NULL, workspace_id uuid NOT NULL, organization_id uuid NOT NULL,
 actor_id uuid REFERENCES users(id), kind text NOT NULL, note text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(issue_id,workspace_id,organization_id) REFERENCES answer_issues(id,workspace_id,organization_id) ON DELETE CASCADE
);
ALTER TABLE knowledge_improvements ADD COLUMN answer_issue_id uuid REFERENCES answer_issues(id) ON DELETE SET NULL;
CREATE TABLE knowledge_regression_datasets (
 knowledge_base_id uuid PRIMARY KEY, dataset_id uuid NOT NULL, workspace_id uuid NOT NULL, organization_id uuid NOT NULL,
 FOREIGN KEY(knowledge_base_id,workspace_id,organization_id) REFERENCES knowledge_bases(id,workspace_id,organization_id) ON DELETE CASCADE,
 FOREIGN KEY(dataset_id,workspace_id,organization_id) REFERENCES evaluation_datasets(id,workspace_id,organization_id)
);
ALTER TABLE evaluation_runs ADD COLUMN candidate_release_id uuid REFERENCES knowledge_releases(id) ON DELETE CASCADE;
ALTER TABLE evaluation_runs ADD COLUMN candidate_version_id uuid REFERENCES agent_versions(id) ON DELETE CASCADE;
ALTER TABLE evaluation_runs ADD CONSTRAINT candidate_version_requires_release CHECK(candidate_version_id IS NULL OR candidate_release_id IS NOT NULL);
CREATE INDEX candidate_release_evaluations ON evaluation_runs(candidate_release_id,agent_id,candidate_version_id,created_at DESC) WHERE candidate_release_id IS NOT NULL;
