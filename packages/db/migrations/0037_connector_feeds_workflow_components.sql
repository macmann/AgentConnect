ALTER TABLE enterprise_connectors ADD COLUMN feed_state jsonb;
ALTER TABLE connector_syncs ADD COLUMN inventory_mode text NOT NULL DEFAULT 'scan';
CREATE TABLE workflow_components (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  revision integer NOT NULL DEFAULT 1,
  archived_at timestamptz,
  created_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, organization_id) REFERENCES workspaces(id, organization_id) ON DELETE CASCADE
);
CREATE TABLE workflow_component_versions (
  component_id uuid NOT NULL REFERENCES workflow_components(id) ON DELETE CASCADE,
  version integer NOT NULL,
  graph jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(component_id, version)
);
