ALTER TABLE enterprise_connectors DROP CONSTRAINT enterprise_connectors_kind_check;
ALTER TABLE enterprise_connectors ADD CONSTRAINT enterprise_connectors_kind_check CHECK(kind IN ('s3','google-drive','onedrive'));
