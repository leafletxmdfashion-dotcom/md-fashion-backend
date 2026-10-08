// SQL migrations are embedded as strings so the bundled build ships them without
// extra file copying. Never edit an applied migration; append a new one.
export const migrations: { id: string; sql: string }[] = [
  {
    id: "0001_auth",
    sql: /* sql */ `
      CREATE TYPE user_status AS ENUM ('ACTIVE', 'INVITED', 'DISABLED', 'LOCKED');

      CREATE TABLE roles (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        key text NOT NULL UNIQUE CHECK (key ~ '^[A-Z][A-Z_]{1,31}$'),
        name text NOT NULL,
        rank integer NOT NULL UNIQUE CHECK (rank > 0),
        created_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE role_permissions (
        role_id uuid NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
        permission text NOT NULL CHECK (permission ~ '^[a-z]+\\.[a-z]+$'),
        PRIMARY KEY (role_id, permission)
      );

      CREATE TABLE users (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        email text NOT NULL,
        name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
        password_hash text,
        status user_status NOT NULL DEFAULT 'INVITED',
        role_id uuid NOT NULL REFERENCES roles (id),
        failed_login_count integer NOT NULL DEFAULT 0 CHECK (failed_login_count >= 0),
        last_failed_login_at timestamptz,
        locked_until timestamptz,
        last_login_at timestamptz,
        password_changed_at timestamptz,
        created_by uuid REFERENCES users (id) ON DELETE SET NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT users_email_key UNIQUE (email),
        CONSTRAINT users_email_length CHECK (char_length(email) BETWEEN 3 AND 254),
        CONSTRAINT users_password_required CHECK (status = 'INVITED' OR password_hash IS NOT NULL)
      );
      CREATE INDEX users_role_status_idx ON users (role_id, status);

      CREATE TABLE sessions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        token_hash bytea NOT NULL CHECK (octet_length(token_hash) = 32),
        created_at timestamptz NOT NULL DEFAULT now(),
        last_seen_at timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz NOT NULL,
        revoked_at timestamptz,
        revoked_reason text,
        ip_address inet,
        user_agent text,
        CONSTRAINT sessions_token_hash_key UNIQUE (token_hash)
      );
      CREATE INDEX sessions_user_active_idx ON sessions (user_id) WHERE revoked_at IS NULL;
      CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);

      CREATE TABLE password_reset_tokens (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        token_hash bytea NOT NULL CHECK (octet_length(token_hash) = 32),
        created_at timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz NOT NULL,
        used_at timestamptz,
        requested_ip inet,
        CONSTRAINT password_reset_tokens_token_hash_key UNIQUE (token_hash)
      );
      CREATE INDEX password_reset_tokens_user_unused_idx ON password_reset_tokens (user_id) WHERE used_at IS NULL;

      CREATE TABLE invitations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        token_hash bytea NOT NULL CHECK (octet_length(token_hash) = 32),
        invited_by uuid REFERENCES users (id) ON DELETE SET NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz NOT NULL,
        accepted_at timestamptz,
        revoked_at timestamptz,
        CONSTRAINT invitations_token_hash_key UNIQUE (token_hash)
      );
      -- At most one open invitation per invited user.
      CREATE UNIQUE INDEX invitations_one_open_per_user_idx ON invitations (user_id)
        WHERE accepted_at IS NULL AND revoked_at IS NULL;

      CREATE TABLE audit_events (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        event_type text NOT NULL,
        actor_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
        target_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
        session_id uuid,
        ip_address inet,
        user_agent text,
        metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX audit_events_target_created_idx ON audit_events (target_user_id, created_at DESC);
      CREATE INDEX audit_events_type_created_idx ON audit_events (event_type, created_at DESC);

      INSERT INTO roles (key, name, rank) VALUES
        ('OWNER', 'Owner', 100),
        ('ADMIN', 'Administrator', 80),
        ('MANAGER', 'Manager', 60),
        ('STAFF', 'Staff', 40),
        ('VIEWER', 'Viewer', 20);

      INSERT INTO role_permissions (role_id, permission)
      SELECT r.id, p.permission
      FROM roles r
      JOIN (VALUES
        ('OWNER', 'dashboard.view'), ('OWNER', 'products.view'), ('OWNER', 'products.create'),
        ('OWNER', 'products.update'), ('OWNER', 'products.delete'), ('OWNER', 'garments.view'),
        ('OWNER', 'garments.create'), ('OWNER', 'garments.update'), ('OWNER', 'garments.delete'),
        ('OWNER', 'inventory.view'), ('OWNER', 'inventory.adjust'), ('OWNER', 'leftovers.view'),
        ('OWNER', 'leftovers.manage'), ('OWNER', 'orders.view'), ('OWNER', 'orders.create'),
        ('OWNER', 'orders.update'), ('OWNER', 'orders.cancel'), ('OWNER', 'customers.view'),
        ('OWNER', 'customers.manage'), ('OWNER', 'reports.view'), ('OWNER', 'users.view'),
        ('OWNER', 'users.manage'), ('OWNER', 'settings.manage'),

        ('ADMIN', 'dashboard.view'), ('ADMIN', 'products.view'), ('ADMIN', 'products.create'),
        ('ADMIN', 'products.update'), ('ADMIN', 'products.delete'), ('ADMIN', 'garments.view'),
        ('ADMIN', 'garments.create'), ('ADMIN', 'garments.update'), ('ADMIN', 'garments.delete'),
        ('ADMIN', 'inventory.view'), ('ADMIN', 'inventory.adjust'), ('ADMIN', 'leftovers.view'),
        ('ADMIN', 'leftovers.manage'), ('ADMIN', 'orders.view'), ('ADMIN', 'orders.create'),
        ('ADMIN', 'orders.update'), ('ADMIN', 'orders.cancel'), ('ADMIN', 'customers.view'),
        ('ADMIN', 'customers.manage'), ('ADMIN', 'reports.view'), ('ADMIN', 'users.view'),
        ('ADMIN', 'users.manage'),

        ('MANAGER', 'dashboard.view'), ('MANAGER', 'products.view'), ('MANAGER', 'products.create'),
        ('MANAGER', 'products.update'), ('MANAGER', 'garments.view'), ('MANAGER', 'garments.create'),
        ('MANAGER', 'garments.update'), ('MANAGER', 'inventory.view'), ('MANAGER', 'inventory.adjust'),
        ('MANAGER', 'leftovers.view'), ('MANAGER', 'leftovers.manage'), ('MANAGER', 'orders.view'),
        ('MANAGER', 'orders.create'), ('MANAGER', 'orders.update'), ('MANAGER', 'orders.cancel'),
        ('MANAGER', 'customers.view'), ('MANAGER', 'customers.manage'), ('MANAGER', 'reports.view'),
        ('MANAGER', 'users.view'),

        ('STAFF', 'dashboard.view'), ('STAFF', 'products.view'), ('STAFF', 'garments.view'),
        ('STAFF', 'inventory.view'), ('STAFF', 'inventory.adjust'), ('STAFF', 'leftovers.view'),
        ('STAFF', 'leftovers.manage'), ('STAFF', 'orders.view'), ('STAFF', 'orders.create'),
        ('STAFF', 'orders.update'), ('STAFF', 'customers.view'),

        ('VIEWER', 'dashboard.view'), ('VIEWER', 'products.view'), ('VIEWER', 'garments.view'),
        ('VIEWER', 'inventory.view'), ('VIEWER', 'leftovers.view'), ('VIEWER', 'orders.view'),
        ('VIEWER', 'customers.view'), ('VIEWER', 'reports.view')
      ) AS p (role_key, permission) ON p.role_key = r.key;
    `,
  },
];
