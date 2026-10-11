ALTER TABLE knowledge_bases ADD COLUMN approval_required boolean NOT NULL DEFAULT false;
ALTER TABLE knowledge_bases ADD COLUMN published_release_id uuid;
CREATE TABLE knowledge_releases (
 id uuid PRIMARY KEY, knowledge_base_id uuid NOT NULL, workspace_id uuid NOT NULL, organization_id uuid NOT NULL,
 version integer NOT NULL CHECK(version>0), name text NOT NULL, notes text NOT NULL DEFAULT '',
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','review','approved','published','rejected')),
 author_id uuid NOT NULL REFERENCES users(id), reviewer_id uuid REFERENCES users(id), review_note text NOT NULL DEFAULT '',
 created_at timestamptz NOT NULL DEFAULT now(), reviewed_at timestamptz, published_at timestamptz,
 UNIQUE(knowledge_base_id,version), UNIQUE(id,knowledge_base_id,workspace_id,organization_id),
 FOREIGN KEY(knowledge_base_id,workspace_id,organization_id) REFERENCES knowledge_bases(id,workspace_id,organization_id) ON DELETE CASCADE,
 CHECK(reviewer_id IS NULL OR reviewer_id<>author_id)
);
ALTER TABLE knowledge_bases ADD CONSTRAINT knowledge_published_release_scope FOREIGN KEY(published_release_id,id,workspace_id,organization_id) REFERENCES knowledge_releases(id,knowledge_base_id,workspace_id,organization_id);
-- Immutable extracted content/embedding snapshots: editing live sources cannot rewrite an approved release.
CREATE TABLE knowledge_release_chunks (
 release_id uuid NOT NULL, id uuid NOT NULL, document_id uuid NOT NULL, source_id uuid NOT NULL,
 knowledge_base_id uuid NOT NULL, workspace_id uuid NOT NULL, organization_id uuid NOT NULL,
 source_revision integer NOT NULL, content text NOT NULL, page integer, heading text, title text NOT NULL, source_url text,
 kind text NOT NULL, dimensions integer NOT NULL, embedding vector NOT NULL CHECK(vector_dims(embedding)=dimensions),
 search_vector tsvector GENERATED ALWAYS AS(to_tsvector('simple',content)) STORED,
 PRIMARY KEY(release_id,id),
 FOREIGN KEY(release_id,knowledge_base_id,workspace_id,organization_id) REFERENCES knowledge_releases(id,knowledge_base_id,workspace_id,organization_id) ON DELETE CASCADE,
 FOREIGN KEY(source_id,knowledge_base_id,workspace_id,organization_id) REFERENCES knowledge_sources(id,knowledge_base_id,workspace_id,organization_id) ON DELETE CASCADE
);
CREATE INDEX release_chunks_lookup ON knowledge_release_chunks(release_id,knowledge_base_id);
CREATE INDEX release_chunks_lexical ON knowledge_release_chunks USING gin(search_vector);
ALTER TABLE conversations ADD COLUMN journey_state jsonb NOT NULL DEFAULT '{}';
ALTER TABLE agent_runs ADD COLUMN answer_kind text CHECK(answer_kind IN ('answer','clarify','no_answer','journey','handoff'));
