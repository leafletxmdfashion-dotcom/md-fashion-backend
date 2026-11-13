-- Staff and karigars may sign in with a phone number instead of an email.
ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
ALTER TABLE users ADD COLUMN phone text;
CREATE UNIQUE INDEX users_phone_key ON users (phone);
ALTER TABLE users ADD CONSTRAINT users_login_id_present CHECK (email IS NOT NULL OR phone IS NOT NULL);
ALTER TABLE users ADD CONSTRAINT users_phone_format CHECK (phone IS NULL OR phone ~ '^\+?[0-9]{7,15}$');

-- A password chosen by an admin must be replaced by the user before anything else.
ALTER TABLE users ADD COLUMN must_change_password boolean NOT NULL DEFAULT false;
