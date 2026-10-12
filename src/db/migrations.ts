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
  {
    id: "0002_fabric",
    sql: /* sql */ `
      CREATE TABLE fabrics (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        code text NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9-]{0,23}$'),
        name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
        unit text NOT NULL CHECK (unit IN ('KG', 'METER')),
        category text NOT NULL CHECK (category IN ('KNIT', 'WOVEN', 'DENIM', 'TRIM', 'LINING', 'OTHER')),
        low_stock_threshold numeric(12, 3) CHECK (low_stock_threshold >= 0),
        description text CHECK (char_length(description) <= 500),
        is_active boolean NOT NULL DEFAULT true,
        created_by uuid REFERENCES users (id),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT fabrics_code_key UNIQUE (code)
      );

      -- A purchase is posted immediately; corrections reverse it, never edit or delete it.
      CREATE TABLE fabric_inwards (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        number integer GENERATED ALWAYS AS IDENTITY UNIQUE,
        fabric_id uuid NOT NULL REFERENCES fabrics (id),
        inward_date date NOT NULL,
        quantity numeric(12, 3) NOT NULL CHECK (quantity > 0),
        rate numeric(12, 2) NOT NULL CHECK (rate >= 0),
        amount numeric(14, 2) GENERATED ALWAYS AS (round(quantity * rate, 2)) STORED,
        supplier text CHECK (char_length(supplier) <= 100),
        invoice_ref text CHECK (char_length(invoice_ref) <= 50),
        color text CHECK (char_length(color) <= 50),
        roll_ref text CHECK (char_length(roll_ref) <= 50),
        notes text CHECK (char_length(notes) <= 500),
        created_by uuid NOT NULL REFERENCES users (id),
        created_at timestamptz NOT NULL DEFAULT now(),
        reversed_at timestamptz,
        reversed_by uuid REFERENCES users (id),
        reversal_reason text CHECK (char_length(reversal_reason) <= 500),
        CONSTRAINT fabric_inwards_reversal_complete CHECK ((reversed_at IS NULL) = (reversal_reason IS NULL))
      );
      CREATE INDEX fabric_inwards_date_idx ON fabric_inwards (inward_date DESC, number DESC);
      CREATE INDEX fabric_inwards_fabric_idx ON fabric_inwards (fabric_id, inward_date DESC);

      -- The stock ledger. Balances are always summed from these rows, never stored.
      CREATE TABLE fabric_movements (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
        fabric_id uuid NOT NULL REFERENCES fabrics (id),
        movement_date date NOT NULL,
        type text NOT NULL CHECK (type IN ('PURCHASE_IN', 'PURCHASE_REVERSAL', 'ADJUSTMENT_IN', 'ADJUSTMENT_OUT')),
        qty_in numeric(12, 3) NOT NULL DEFAULT 0 CHECK (qty_in >= 0),
        qty_out numeric(12, 3) NOT NULL DEFAULT 0 CHECK (qty_out >= 0),
        color text,
        roll_ref text,
        inward_id uuid REFERENCES fabric_inwards (id),
        reason text CHECK (char_length(reason) <= 500),
        created_by uuid NOT NULL REFERENCES users (id),
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT fabric_movements_one_direction CHECK ((qty_in > 0) <> (qty_out > 0))
      );
      CREATE INDEX fabric_movements_fabric_idx ON fabric_movements (fabric_id, movement_date, seq);
      CREATE INDEX fabric_movements_date_idx ON fabric_movements (movement_date DESC, seq DESC);

      CREATE FUNCTION reject_ledger_change() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
      END $$;
      CREATE TRIGGER fabric_movements_append_only BEFORE UPDATE OR DELETE ON fabric_movements
        FOR EACH ROW EXECUTE FUNCTION reject_ledger_change();

      INSERT INTO role_permissions (role_id, permission)
      SELECT r.id, p.permission
      FROM roles r
      JOIN (VALUES
        ('OWNER', 'fabric.view'), ('OWNER', 'fabric.manage'), ('OWNER', 'fabric.inward'), ('OWNER', 'fabric.adjust'),
        ('ADMIN', 'fabric.view'), ('ADMIN', 'fabric.manage'), ('ADMIN', 'fabric.inward'), ('ADMIN', 'fabric.adjust'),
        ('MANAGER', 'fabric.view'), ('MANAGER', 'fabric.manage'), ('MANAGER', 'fabric.inward'),
        ('STAFF', 'fabric.view'), ('STAFF', 'fabric.inward'),
        ('VIEWER', 'fabric.view')
      ) AS p (role_key, permission) ON p.role_key = r.key;
    `,
  },
  {
    id: "0003_fabric_performance",
    sql: /* sql */ `
      CREATE EXTENSION IF NOT EXISTS pg_trgm;

      -- Per-fabric totals projected from the ledger by trigger, in the same transaction
      -- as each posting. The ledger stays the source of truth; this saves summing every
      -- movement on every list request. The CHECK makes negative stock impossible.
      CREATE TABLE fabric_stock (
        fabric_id uuid PRIMARY KEY REFERENCES fabrics (id) ON DELETE CASCADE,
        balance numeric(14, 3) NOT NULL DEFAULT 0 CHECK (balance >= 0),
        movement_count integer NOT NULL DEFAULT 0,
        purchased_qty numeric(14, 3) NOT NULL DEFAULT 0,
        purchased_amount numeric(16, 2) NOT NULL DEFAULT 0
      );

      INSERT INTO fabric_stock (fabric_id, balance, movement_count, purchased_qty, purchased_amount)
      SELECT f.id,
             COALESCE((SELECT sum(qty_in - qty_out) FROM fabric_movements m WHERE m.fabric_id = f.id), 0),
             (SELECT count(*) FROM fabric_movements m WHERE m.fabric_id = f.id),
             COALESCE((SELECT sum(quantity) FROM fabric_inwards i WHERE i.fabric_id = f.id AND i.reversed_at IS NULL), 0),
             COALESCE((SELECT sum(amount) FROM fabric_inwards i WHERE i.fabric_id = f.id AND i.reversed_at IS NULL), 0)
      FROM fabrics f;

      CREATE FUNCTION fabric_stock_init() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        INSERT INTO fabric_stock (fabric_id) VALUES (NEW.id);
        RETURN NEW;
      END $$;
      CREATE TRIGGER fabrics_stock_init AFTER INSERT ON fabrics
        FOR EACH ROW EXECUTE FUNCTION fabric_stock_init();

      CREATE FUNCTION fabric_stock_apply() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        sign integer := CASE NEW.type WHEN 'PURCHASE_IN' THEN 1 WHEN 'PURCHASE_REVERSAL' THEN -1 ELSE 0 END;
        inward_amount numeric(16, 2) := 0;
      BEGIN
        IF sign <> 0 THEN
          SELECT amount INTO inward_amount FROM fabric_inwards WHERE id = NEW.inward_id;
        END IF;
        UPDATE fabric_stock
        SET balance = balance + NEW.qty_in - NEW.qty_out,
            movement_count = movement_count + 1,
            purchased_qty = purchased_qty + sign * (NEW.qty_in + NEW.qty_out),
            purchased_amount = purchased_amount + sign * inward_amount
        WHERE fabric_id = NEW.fabric_id;
        RETURN NEW;
      END $$;
      CREATE TRIGGER fabric_movements_stock AFTER INSERT ON fabric_movements
        FOR EACH ROW EXECUTE FUNCTION fabric_stock_apply();

      -- Running balances read this range per row as an index-only scan.
      DROP INDEX fabric_movements_fabric_idx;
      CREATE INDEX fabric_movements_fabric_idx ON fabric_movements (fabric_id, movement_date, seq)
        INCLUDE (qty_in, qty_out);
      CREATE INDEX fabric_movements_type_date_idx ON fabric_movements (type, movement_date DESC, seq DESC);

      -- One trigram-indexed haystack for the purchase register's free-text search.
      ALTER TABLE fabric_inwards ADD COLUMN search_text text GENERATED ALWAYS AS (
        lower(COALESCE(supplier, '') || ' ' || COALESCE(invoice_ref, '') || ' ' ||
              COALESCE(color, '') || ' ' || COALESCE(roll_ref, ''))
      ) STORED;
      CREATE INDEX fabric_inwards_search_idx ON fabric_inwards USING gin (search_text gin_trgm_ops);
      CREATE INDEX fabrics_search_idx ON fabrics USING gin (lower(name || ' ' || code) gin_trgm_ops);
    `,
  },
  {
    id: "0004_fabric_free_category",
    sql: /* sql */ `
      -- Category becomes optional free text. Existing codes keep their meaning as words.
      ALTER TABLE fabrics DROP CONSTRAINT fabrics_category_check;
      ALTER TABLE fabrics ALTER COLUMN category DROP NOT NULL;
      UPDATE fabrics SET category = initcap(lower(category));
      ALTER TABLE fabrics ADD CONSTRAINT fabrics_category_check
        CHECK (category IS NULL OR char_length(category) BETWEEN 1 AND 50);
    `,
  },
];
