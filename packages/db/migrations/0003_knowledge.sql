CREATE TABLE embedding_models (
 id uuid PRIMARY KEY,organization_id uuid NOT NULL,workspace_id uuid NOT NULL,name text NOT NULL,
 provider text NOT NULL CHECK(provider IN ('openai','openai-compatible','gemini')),model_id text NOT NULL,base_url text NOT NULL,secret_id uuid,
 dimensions integer NOT NULL CHECK(dimensions BETWEEN 1 AND 2000),created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,workspace_id,organization_id,dimensions), UNIQUE(id,workspace_id,organization_id),
 FOREIGN KEY(workspace_id,organization_id) REFERENCES workspaces(id,organization_id),
 FOREIGN KEY(secret_id,workspace_id,organization_id) REFERENCES secrets(id,workspace_id,organization_id)
);
CREATE TABLE knowledge_bases (
 id uuid PRIMARY KEY,organization_id uuid NOT NULL,workspace_id uuid NOT NULL,name text NOT NULL,description text NOT NULL,
 embedding_model_id uuid NOT NULL,dimensions integer NOT NULL,chunk_size integer NOT NULL CHECK(chunk_size BETWEEN 200 AND 4000),chunk_overlap integer NOT NULL CHECK(chunk_overlap>=0 AND chunk_overlap<chunk_size),chunk_strategy text NOT NULL CHECK(chunk_strategy IN ('recursive','page','heading')),
 public_access boolean NOT NULL DEFAULT false,revision integer NOT NULL DEFAULT 1,archived_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,workspace_id,organization_id), UNIQUE(id,workspace_id,organization_id,embedding_model_id,dimensions),
 FOREIGN KEY(embedding_model_id,workspace_id,organization_id,dimensions) REFERENCES embedding_models(id,workspace_id,organization_id,dimensions)
);
CREATE TABLE knowledge_sources (
 id uuid PRIMARY KEY,knowledge_base_id uuid NOT NULL,organization_id uuid NOT NULL,workspace_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('upload','text','qa','website')),title text NOT NULL,filename text,object_key text,source_url text,
 byte_size integer NOT NULL DEFAULT 0,metadata jsonb NOT NULL DEFAULT '{}',revision integer NOT NULL DEFAULT 1,
 status text NOT NULL CHECK(status IN ('queued','processing','ready','failed','deleted')),error_code text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,knowledge_base_id,workspace_id,organization_id),
 FOREIGN KEY(knowledge_base_id,workspace_id,organization_id) REFERENCES knowledge_bases(id,workspace_id,organization_id)
);
CREATE TABLE knowledge_documents (
 id uuid PRIMARY KEY,source_id uuid NOT NULL,knowledge_base_id uuid NOT NULL,organization_id uuid NOT NULL,workspace_id uuid NOT NULL,
 title text NOT NULL,source_url text,metadata jsonb NOT NULL,page_count integer NOT NULL,content_hash text NOT NULL,revision integer NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(id,source_id,knowledge_base_id,workspace_id,organization_id),
 FOREIGN KEY(source_id,knowledge_base_id,workspace_id,organization_id) REFERENCES knowledge_sources(id,knowledge_base_id,workspace_id,organization_id)
);
CREATE TABLE knowledge_chunks (
 id uuid PRIMARY KEY,document_id uuid NOT NULL,source_id uuid NOT NULL,knowledge_base_id uuid NOT NULL,workspace_id uuid NOT NULL,organization_id uuid NOT NULL,
 embedding_model_id uuid NOT NULL,dimensions integer NOT NULL,ordinal integer NOT NULL,content text NOT NULL,page integer,heading text,
 metadata jsonb NOT NULL,embedding vector NOT NULL CHECK(vector_dims(embedding)=dimensions),
 search_vector tsvector GENERATED ALWAYS AS (to_tsvector('simple',content)) STORED,
 FOREIGN KEY(document_id,source_id,knowledge_base_id,workspace_id,organization_id) REFERENCES knowledge_documents(id,source_id,knowledge_base_id,workspace_id,organization_id) ON DELETE CASCADE,
 FOREIGN KEY(knowledge_base_id,workspace_id,organization_id,embedding_model_id,dimensions) REFERENCES knowledge_bases(id,workspace_id,organization_id,embedding_model_id,dimensions),
 UNIQUE(document_id,ordinal)
);
CREATE INDEX chunks_knowledge ON knowledge_chunks(knowledge_base_id,source_id);
CREATE INDEX chunks_lexical ON knowledge_chunks USING gin(search_vector);
CREATE TABLE knowledge_jobs (
 id uuid PRIMARY KEY,source_id uuid NOT NULL,knowledge_base_id uuid NOT NULL,organization_id uuid NOT NULL,workspace_id uuid NOT NULL,
 source_revision integer NOT NULL,payload jsonb NOT NULL,status text NOT NULL CHECK(status IN ('queued','running','completed','failed','cancelled')),
 attempts integer NOT NULL DEFAULT 0,available_at timestamptz NOT NULL DEFAULT now(),locked_until timestamptz,lease_token uuid,error_code text,
 created_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz,
 FOREIGN KEY(source_id,knowledge_base_id,workspace_id,organization_id) REFERENCES knowledge_sources(id,knowledge_base_id,workspace_id,organization_id),
 UNIQUE(source_id,source_revision)
);
CREATE INDEX knowledge_job_pending ON knowledge_jobs(available_at) WHERE status IN ('queued','running');
ALTER TABLE messages ADD COLUMN citations jsonb NOT NULL DEFAULT '[]';
ALTER TABLE agent_runs ADD COLUMN retrieval jsonb NOT NULL DEFAULT '[]';
ALTER TABLE agent_runs ADD COLUMN retrieval_ms integer;
