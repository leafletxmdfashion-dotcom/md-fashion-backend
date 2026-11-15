-- Audit log: who did what is kept as it was at the time. The actor's name and role are
-- copied onto each event (a trigger fills them from the actor, so every caller gets them),
-- the request id ties an event to the server log line, and events can never be changed
-- or deleted by the application.
ALTER TABLE audit_events
  ADD COLUMN actor_name text,
  ADD COLUMN actor_role_key text,
  ADD COLUMN actor_role_name text,
  ADD COLUMN request_id text CHECK (char_length(request_id) <= 100);

CREATE FUNCTION audit_events_snapshot_actor() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.actor_user_id IS NOT NULL AND NEW.actor_name IS NULL THEN
    SELECT u.name, r.key, r.name INTO NEW.actor_name, NEW.actor_role_key, NEW.actor_role_name
    FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = NEW.actor_user_id;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER audit_events_snapshot_actor BEFORE INSERT ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_snapshot_actor();

-- Events before this migration: the actor as they are now (the best that is known).
UPDATE audit_events e SET actor_name = u.name, actor_role_key = r.key, actor_role_name = r.name
FROM users u JOIN roles r ON r.id = u.role_id
WHERE u.id = e.actor_user_id AND e.actor_name IS NULL;

CREATE FUNCTION audit_events_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only' USING ERRCODE = 'restrict_violation';
END $$;

CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_append_only();

CREATE INDEX audit_events_created_idx ON audit_events (created_at DESC);
CREATE INDEX audit_events_actor_created_idx ON audit_events (actor_user_id, created_at DESC);
CREATE INDEX audit_events_ip_idx ON audit_events (ip_address) WHERE ip_address IS NOT NULL;
CREATE INDEX audit_events_session_idx ON audit_events (session_id) WHERE session_id IS NOT NULL;

-- Reading the audit log is its own right; administrators get it.
INSERT INTO role_permissions (role_id, permission)
SELECT id, 'audit.view' FROM roles WHERE key = 'ADMIN'
ON CONFLICT DO NOTHING;
