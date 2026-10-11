ALTER TABLE knowledge_bases ADD COLUMN advanced_processing jsonb NOT NULL DEFAULT '{"enabled":false,"llmAssisted":false,"modelId":null,"chunkTokens":500}'::jsonb;
ALTER TABLE knowledge_bases ADD COLUMN parent_context boolean NOT NULL DEFAULT false;
-- Preserve context provenance in immutable release snapshots; existing releases stay unchanged.
ALTER TABLE knowledge_release_chunks ADD COLUMN metadata jsonb NOT NULL DEFAULT '{}'::jsonb;
