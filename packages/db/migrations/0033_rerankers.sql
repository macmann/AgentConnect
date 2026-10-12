CREATE TABLE rerankers (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL, organization_id uuid NOT NULL,
 name text NOT NULL, provider text NOT NULL CHECK(provider IN ('llm','cohere')),
 model_configuration_id uuid, model_id text NOT NULL DEFAULT '', base_url text NOT NULL DEFAULT 'https://api.cohere.com', secret_id uuid,
 enabled boolean NOT NULL DEFAULT true, revision integer NOT NULL DEFAULT 1 CHECK(revision>0), archived_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,workspace_id,organization_id),
 FOREIGN KEY(workspace_id,organization_id) REFERENCES workspaces(id,organization_id),
 FOREIGN KEY(model_configuration_id,workspace_id,organization_id) REFERENCES model_configurations(id,workspace_id,organization_id),
 FOREIGN KEY(secret_id,workspace_id,organization_id) REFERENCES secrets(id,workspace_id,organization_id),
 CHECK((provider='llm' AND model_configuration_id IS NOT NULL AND secret_id IS NULL) OR (provider='cohere' AND model_configuration_id IS NULL AND secret_id IS NOT NULL AND length(model_id)>0))
);
CREATE INDEX rerankers_workspace ON rerankers(workspace_id) WHERE archived_at IS NULL;
