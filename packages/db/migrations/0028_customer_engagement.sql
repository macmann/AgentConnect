CREATE TABLE customer_feedback (
 conversation_id uuid PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
 organization_id uuid NOT NULL, workspace_id uuid NOT NULL,
 rating integer CHECK(rating BETWEEN 1 AND 5), resolved boolean, comment text NOT NULL DEFAULT '',
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(workspace_id,organization_id) REFERENCES workspaces(id,organization_id)
);
ALTER TABLE workflow_runs ADD COLUMN conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL;
ALTER TABLE workflow_runs ADD COLUMN customer_action_id text;
CREATE INDEX customer_workflow_runs ON workflow_runs(conversation_id,created_at DESC) WHERE conversation_id IS NOT NULL;
CREATE TABLE knowledge_gap_assignments (
 run_id uuid PRIMARY KEY REFERENCES agent_runs(id) ON DELETE CASCADE,
 workspace_id uuid NOT NULL, organization_id uuid NOT NULL, group_key text NOT NULL,
 updated_by uuid NOT NULL REFERENCES users(id), updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(workspace_id,organization_id) REFERENCES workspaces(id,organization_id)
);
CREATE TABLE messaging_channels (
 id uuid PRIMARY KEY,workspace_id uuid NOT NULL,organization_id uuid NOT NULL,
 deployment_id uuid NOT NULL REFERENCES deployments(id), name text NOT NULL,
 provider text NOT NULL CHECK(provider IN ('messenger','viber','telegram','teams')),
 credentials jsonb NOT NULL,settings jsonb NOT NULL DEFAULT '{}',
 enabled boolean NOT NULL DEFAULT false, connected_at timestamptz,last_error text,
 created_by uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(workspace_id,organization_id) REFERENCES workspaces(id,organization_id)
);
CREATE TABLE messaging_customers (
 channel_id uuid NOT NULL REFERENCES messaging_channels(id) ON DELETE CASCADE, external_id text NOT NULL,
 conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, guest_token jsonb NOT NULL,
 address jsonb NOT NULL DEFAULT '{}', last_support_at timestamptz NOT NULL DEFAULT 'epoch',last_support_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
 PRIMARY KEY(channel_id,external_id)
);
CREATE TABLE messaging_inbox (
 id uuid PRIMARY KEY,channel_id uuid NOT NULL REFERENCES messaging_channels(id) ON DELETE CASCADE,
 external_id text NOT NULL,event_id text NOT NULL,content text NOT NULL,address jsonb NOT NULL DEFAULT '{}',
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','processing','sending','completed','failed')),
 reply text, error_code text, attempts integer NOT NULL DEFAULT 0,lease_owner uuid,lease_expires_at timestamptz,
 next_attempt_at timestamptz NOT NULL DEFAULT now(),created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(channel_id,event_id)
);
CREATE INDEX messaging_inbox_queue ON messaging_inbox(status,next_attempt_at);
ALTER TABLE conversations DROP CONSTRAINT conversations_channel_check;
ALTER TABLE conversations ADD CONSTRAINT conversations_channel_check CHECK(channel IN ('playground','hosted','widget','messenger','viber','telegram','teams'));

ALTER TABLE workflow_runs ALTER COLUMN user_id DROP NOT NULL;

ALTER TABLE knowledge_gap_assignments ADD COLUMN method text NOT NULL DEFAULT 'reviewer';

ALTER TABLE messaging_channels ADD COLUMN last_received_at timestamptz;

ALTER TABLE messaging_inbox ADD COLUMN conversation_id uuid REFERENCES conversations(id) ON DELETE CASCADE;
ALTER TABLE messaging_inbox ADD COLUMN delivery_offset integer NOT NULL DEFAULT 0;
