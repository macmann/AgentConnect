ALTER TABLE mcp_connectors ADD COLUMN transport text NOT NULL DEFAULT 'http' CHECK (transport IN ('http','stdio'));
ALTER TABLE mcp_connectors ADD COLUMN stdio jsonb;
ALTER TABLE tools DROP CONSTRAINT tools_kind_check;
ALTER TABLE tools ADD CONSTRAINT tools_kind_check CHECK (kind IN ('http','database','search','mcp','financial','api'));
ALTER TABLE mcp_connectors ADD COLUMN auth_header text NOT NULL DEFAULT 'Authorization';
