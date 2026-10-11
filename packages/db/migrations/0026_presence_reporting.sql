-- Availability changes must close the observed staffed interval even when the
-- explicit presence status is unchanged.
CREATE OR REPLACE FUNCTION record_operator_presence() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO operator_presence_samples(workspace_id,organization_id,user_id,status,expires_at)
 VALUES(NEW.workspace_id,NEW.organization_id,NEW.user_id,CASE WHEN NEW.enabled AND NEW.manual_availability THEN NEW.presence_status ELSE 'offline' END,NEW.presence_expires_at);
 RETURN NEW;
END $$;
DROP TRIGGER operator_presence_history ON operator_profiles;
CREATE TRIGGER operator_presence_history AFTER INSERT OR UPDATE OF presence_status,presence_expires_at,enabled,manual_availability ON operator_profiles FOR EACH ROW EXECUTE FUNCTION record_operator_presence();
INSERT INTO operator_presence_samples(workspace_id,organization_id,user_id,status,expires_at)
 SELECT workspace_id,organization_id,user_id,CASE WHEN enabled AND manual_availability THEN presence_status ELSE 'offline' END,presence_expires_at FROM operator_profiles;
