ALTER TABLE model_configurations ADD COLUMN revision integer NOT NULL DEFAULT 1;
ALTER TABLE model_configurations ADD COLUMN archived_at timestamptz;
