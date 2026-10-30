CREATE TABLE agent_skills (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL, organization_id uuid NOT NULL,
 name text NOT NULL, description text NOT NULL,
 enabled boolean NOT NULL DEFAULT true, public_access boolean NOT NULL DEFAULT false,
 revision integer NOT NULL DEFAULT 1, archived_at timestamptz,
 created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,workspace_id,organization_id),
 FOREIGN KEY(workspace_id,organization_id) REFERENCES workspaces(id,organization_id)
);
CREATE TABLE agent_skill_versions (
 id uuid PRIMARY KEY, skill_id uuid NOT NULL, workspace_id uuid NOT NULL, organization_id uuid NOT NULL,
 version integer NOT NULL CHECK(version>0), name text NOT NULL, description text NOT NULL,
 instructions text NOT NULL, reference_files jsonb NOT NULL DEFAULT '[]'::jsonb,
 ignored_files jsonb NOT NULL DEFAULT '[]'::jsonb, warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
 content_hash text NOT NULL, created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(skill_id,version), UNIQUE(id,workspace_id,organization_id),
 FOREIGN KEY(skill_id,workspace_id,organization_id) REFERENCES agent_skills(id,workspace_id,organization_id)
);
CREATE TRIGGER agent_skill_version_immutable BEFORE UPDATE ON agent_skill_versions FOR EACH ROW EXECUTE FUNCTION immutable_agent_version();
CREATE INDEX agent_skills_workspace ON agent_skills(workspace_id,created_at);
