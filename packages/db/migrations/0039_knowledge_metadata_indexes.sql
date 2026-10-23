-- User metadata stays in existing JSON storage; released metadata is immutable.
CREATE INDEX IF NOT EXISTS knowledge_source_tags_idx ON knowledge_sources USING gin ((COALESCE(metadata->'tags','[]'::jsonb)));
CREATE INDEX IF NOT EXISTS knowledge_source_attributes_idx ON knowledge_sources USING gin ((COALESCE(metadata->'attributes','{}'::jsonb)));
CREATE INDEX IF NOT EXISTS knowledge_release_tags_idx ON knowledge_release_chunks USING gin ((COALESCE(metadata->'sourceTags','[]'::jsonb)));
CREATE INDEX IF NOT EXISTS knowledge_release_attributes_idx ON knowledge_release_chunks USING gin ((COALESCE(metadata->'sourceAttributes','{}'::jsonb)));
