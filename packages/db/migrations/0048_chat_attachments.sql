ALTER TABLE messages
  ADD COLUMN attachments jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN attachment_context text NOT NULL DEFAULT '',
  ADD COLUMN attachment_payload jsonb;
