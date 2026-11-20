-- Business settings: one row. Company details print on reports; the lot pattern only suggests the next
-- lot number (lot numbers are still typed); approval rules decide whether corrections need approval.
CREATE TABLE app_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  company_name text NOT NULL CHECK (char_length(btrim(company_name)) BETWEEN 1 AND 120),
  address text CHECK (char_length(address) <= 300),
  phone text CHECK (char_length(phone) <= 40),
  default_reorder_level numeric(12, 3) CHECK (default_reorder_level >= 0),
  lot_number_pattern text NOT NULL DEFAULT 'LOT-{seq}' CHECK (lot_number_pattern LIKE '%{seq}%' AND char_length(lot_number_pattern) <= 30),
  approve_adjustments boolean NOT NULL DEFAULT false,
  approve_reversals boolean NOT NULL DEFAULT false,
  updated_by uuid REFERENCES users (id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO app_settings (company_name) VALUES ('MD Fashion Center');

-- Rights for the management modules: settings, manual lot costs, deciding approvals, reports.
INSERT INTO role_permissions (role_id, permission)
SELECT r.id, p.permission
FROM roles r
JOIN (VALUES
  ('OWNER', 'settings.manage'), ('ADMIN', 'settings.manage'),
  ('OWNER', 'costing.manage'), ('ADMIN', 'costing.manage'),
  ('OWNER', 'approvals.decide'), ('ADMIN', 'approvals.decide'),
  ('OWNER', 'reports.view'), ('ADMIN', 'reports.view'), ('MANAGER', 'reports.view'), ('ACCOUNTANT', 'reports.view')
) AS p (role_key, permission) ON p.role_key = r.key
ON CONFLICT DO NOTHING;
