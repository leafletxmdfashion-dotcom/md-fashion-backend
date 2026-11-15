-- Per-person access: on top of their role, a person may be given a right the role lacks
-- (ALLOW) or have one of the role's rights taken away (DENY). Effective rights =
-- (role rights + ALLOW) - DENY. Owners always hold everything. Changes are audited.
CREATE TABLE user_permission_overrides (
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  permission text NOT NULL CHECK (char_length(permission) BETWEEN 1 AND 60),
  effect text NOT NULL CHECK (effect IN ('ALLOW', 'DENY')),
  reason text CHECK (char_length(reason) <= 500),
  created_by uuid REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, permission)
);
