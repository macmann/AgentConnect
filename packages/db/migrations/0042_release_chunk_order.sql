-- Preserve document order in immutable release snapshots for bounded neighbors.
-- Historical chunks without a surviving identical live chunk keep unknown order.
ALTER TABLE knowledge_release_chunks ADD COLUMN ordinal integer CHECK (ordinal >= 0);
UPDATE knowledge_release_chunks r SET ordinal=c.ordinal
FROM knowledge_chunks c
WHERE r.id=c.id AND r.document_id=c.document_id AND r.source_id=c.source_id
AND r.knowledge_base_id=c.knowledge_base_id AND r.workspace_id=c.workspace_id
AND r.organization_id=c.organization_id AND r.content=c.content;
CREATE INDEX release_chunk_document_order ON knowledge_release_chunks(release_id,document_id,ordinal);
