-- Roles: custom roles beside the five built-in ones, and a permission catalog
-- trimmed to the modules that exist. Jogadi (stitching teams), stitching issue and
-- receipt, rework, and stitching earnings in the karigar ledger and lot costs.

-- ============ Roles and permissions ============

-- Custom roles share a level (rank 50), so ranks are no longer unique.
ALTER TABLE roles DROP CONSTRAINT roles_rank_key;
ALTER TABLE roles ADD CONSTRAINT roles_name_check CHECK (char_length(btrim(name)) BETWEEN 2 AND 40);
CREATE UNIQUE INDEX roles_name_key ON roles (lower(btrim(name)));

-- Permissions of modules that were never built.
DELETE FROM role_permissions WHERE split_part(permission, '.', 1) IN
  ('products', 'garments', 'inventory', 'leftovers', 'orders', 'customers', 'reports');

-- settings.manage becomes roles.manage, and Administrators get it too.
UPDATE role_permissions SET permission = 'roles.manage' WHERE permission = 'settings.manage';

INSERT INTO role_permissions (role_id, permission)
SELECT r.id, p.permission
FROM roles r
JOIN (VALUES
  ('ADMIN', 'roles.manage'),
  ('OWNER', 'stitching.view'), ('OWNER', 'stitching.issue'), ('OWNER', 'stitching.receive'),
  ('OWNER', 'stitching.rework'), ('OWNER', 'stitching.reverse'),
  ('ADMIN', 'stitching.view'), ('ADMIN', 'stitching.issue'), ('ADMIN', 'stitching.receive'),
  ('ADMIN', 'stitching.rework'), ('ADMIN', 'stitching.reverse'),
  ('MANAGER', 'stitching.view'), ('MANAGER', 'stitching.issue'), ('MANAGER', 'stitching.receive'),
  ('MANAGER', 'stitching.rework'),
  ('STAFF', 'stitching.view'), ('STAFF', 'stitching.issue'), ('STAFF', 'stitching.receive'),
  ('VIEWER', 'stitching.view')
) AS p (role_key, permission) ON p.role_key = r.key
ON CONFLICT DO NOTHING;

-- Split from existing rights so nobody gains or loses anything they had.
INSERT INTO role_permissions (role_id, permission)
SELECT role_id, 'fabric.reverse' FROM role_permissions WHERE permission = 'fabric.adjust'
ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission)
SELECT role_id, 'items.manage' FROM role_permissions WHERE permission = 'production.manage'
ON CONFLICT DO NOTHING;

-- ============ Jogadi teams ============

CREATE TABLE jogadi_teams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number integer GENERATED ALWAYS AS IDENTITY UNIQUE,
  code text GENERATED ALWAYS AS ('JG-' || lpad(number::text, 3, '0')) STORED,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 60),
  active boolean NOT NULL DEFAULT true,
  notes text CHECK (char_length(notes) <= 500),
  created_by uuid NOT NULL REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX jogadi_teams_name_key ON jogadi_teams (lower(btrim(name)));

-- Membership history: leaving sets left_at, never deletes. share_percent is the
-- default earning split (all members of a team have one, or none do: equal split).
CREATE TABLE jogadi_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id uuid NOT NULL REFERENCES jogadi_teams (id),
  karigar_id uuid NOT NULL REFERENCES karigars (id),
  share_percent numeric(5, 2) CHECK (share_percent > 0 AND share_percent <= 100),
  joined_at timestamptz NOT NULL DEFAULT now(),
  left_at timestamptz,
  CHECK (left_at IS NULL OR left_at >= joined_at)
);
CREATE UNIQUE INDEX jogadi_members_current_idx ON jogadi_members (team_id, karigar_id) WHERE left_at IS NULL;
CREATE INDEX jogadi_members_karigar_idx ON jogadi_members (karigar_id) WHERE left_at IS NULL;

-- ============ Stitching issue ============

-- Cut pieces handed to a Jogadi team for one operation at a rate per piece. Posted
-- at once; a mistake is reversed (only while nothing has been received).
CREATE TABLE stitching_issues (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number integer GENERATED ALWAYS AS IDENTITY UNIQUE,
  lot_id uuid NOT NULL REFERENCES production_lots (id),
  team_id uuid NOT NULL REFERENCES jogadi_teams (id),
  team_name text NOT NULL,
  operation text NOT NULL CHECK (char_length(btrim(operation)) BETWEEN 1 AND 60),
  rate numeric(12, 2) NOT NULL CHECK (rate >= 0),
  -- EQUAL or PERCENT, from the team's shares when issued.
  split_method text NOT NULL CHECK (split_method IN ('EQUAL', 'PERCENT')),
  issue_date date NOT NULL,
  notes text CHECK (char_length(notes) <= 500),
  status text NOT NULL DEFAULT 'POSTED' CHECK (status IN ('POSTED', 'REVERSED')),
  reversed_at timestamptz,
  reversed_by uuid REFERENCES users (id),
  reversal_reason text,
  created_by uuid NOT NULL REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stitching_issues_reversal CHECK ((status = 'REVERSED') = (reversed_at IS NOT NULL AND reversal_reason IS NOT NULL))
);
CREATE INDEX stitching_issues_date_idx ON stitching_issues (issue_date DESC, number DESC);
CREATE INDEX stitching_issues_lot_idx ON stitching_issues (lot_id);
CREATE INDEX stitching_issues_team_idx ON stitching_issues (team_id);

CREATE TABLE stitching_issue_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_id uuid NOT NULL REFERENCES stitching_issues (id),
  colour text NOT NULL,
  size_label text NOT NULL,
  position integer NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  -- Maintained by receipts (and their reversals) in the same transaction.
  received integer NOT NULL DEFAULT 0 CHECK (received BETWEEN 0 AND quantity),
  CONSTRAINT stitching_issue_lines_once UNIQUE (issue_id, colour, size_label)
);

-- Who was in the team when the work was issued; later membership changes never
-- touch it. Earnings from this issue are split over these people.
CREATE TABLE stitching_issue_members (
  issue_id uuid NOT NULL REFERENCES stitching_issues (id),
  karigar_id uuid NOT NULL REFERENCES karigars (id),
  karigar_name text NOT NULL,
  share_percent numeric(5, 2),
  PRIMARY KEY (issue_id, karigar_id)
);

-- ============ Stitching receipt ============

CREATE TABLE stitching_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number integer GENERATED ALWAYS AS IDENTITY UNIQUE,
  issue_id uuid NOT NULL REFERENCES stitching_issues (id),
  lot_id uuid NOT NULL REFERENCES production_lots (id),
  receipt_date date NOT NULL,
  split_method text NOT NULL CHECK (split_method IN ('EQUAL', 'PERCENT', 'AMOUNT')),
  good integer NOT NULL CHECK (good >= 0),
  earning numeric(14, 2) NOT NULL CHECK (earning >= 0),
  notes text CHECK (char_length(notes) <= 500),
  status text NOT NULL DEFAULT 'POSTED' CHECK (status IN ('POSTED', 'REVERSED')),
  reversed_at timestamptz,
  reversed_by uuid REFERENCES users (id),
  reversal_reason text,
  created_by uuid NOT NULL REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stitching_receipts_reversal CHECK ((status = 'REVERSED') = (reversed_at IS NOT NULL AND reversal_reason IS NOT NULL))
);
CREATE INDEX stitching_receipts_issue_idx ON stitching_receipts (issue_id);
CREATE INDEX stitching_receipts_lot_idx ON stitching_receipts (lot_id);

CREATE TABLE stitching_receipt_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id uuid NOT NULL REFERENCES stitching_receipts (id),
  issue_line_id uuid NOT NULL REFERENCES stitching_issue_lines (id),
  colour text NOT NULL,
  size_label text NOT NULL,
  received integer NOT NULL CHECK (received > 0),
  good integer NOT NULL CHECK (good >= 0),
  rework integer NOT NULL CHECK (rework >= 0),
  reject integer NOT NULL CHECK (reject >= 0),
  reject_reason text CHECK (char_length(reject_reason) <= 200),
  CONSTRAINT stitching_receipt_lines_balanced CHECK (received = good + rework + reject),
  CONSTRAINT stitching_receipt_lines_reason CHECK (reject = 0 OR reject_reason IS NOT NULL),
  CONSTRAINT stitching_receipt_lines_once UNIQUE (receipt_id, issue_line_id)
);

-- ============ Rework ============

-- Pieces sent back for rework from one receipt line. Recovered pieces become Good
-- (and are paid to the team that stitched them); failed pieces become Reject.
CREATE TABLE rework_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number integer GENERATED ALWAYS AS IDENTITY UNIQUE,
  receipt_line_id uuid NOT NULL UNIQUE REFERENCES stitching_receipt_lines (id),
  receipt_id uuid NOT NULL REFERENCES stitching_receipts (id),
  issue_id uuid NOT NULL REFERENCES stitching_issues (id),
  lot_id uuid NOT NULL REFERENCES production_lots (id),
  colour text NOT NULL,
  size_label text NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  recovered integer NOT NULL DEFAULT 0 CHECK (recovered >= 0),
  failed integer NOT NULL DEFAULT 0 CHECK (failed >= 0),
  status text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'ASSIGNED', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'CANCELLED')),
  assigned_to uuid REFERENCES karigars (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rework_items_balance CHECK (recovered + failed <= quantity),
  -- Closed exactly when nothing is left to resolve (a cancelled item is closed as is).
  CONSTRAINT rework_items_closed CHECK (
    status = 'CANCELLED' OR (status IN ('COMPLETED', 'FAILED')) = (recovered + failed = quantity)
  )
);
CREATE INDEX rework_items_open_idx ON rework_items (created_at DESC) WHERE status NOT IN ('COMPLETED', 'FAILED', 'CANCELLED');
CREATE INDEX rework_items_lot_idx ON rework_items (lot_id);

-- Each resolution (some recovered, some failed). Append-only.
CREATE TABLE rework_resolutions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rework_id uuid NOT NULL REFERENCES rework_items (id),
  resolved_on date NOT NULL,
  recovered integer NOT NULL CHECK (recovered >= 0),
  failed integer NOT NULL CHECK (failed >= 0),
  failed_reason text CHECK (char_length(failed_reason) <= 200),
  earning numeric(14, 2) NOT NULL DEFAULT 0 CHECK (earning >= 0),
  created_by uuid NOT NULL REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (recovered + failed > 0),
  CHECK (failed = 0 OR failed_reason IS NOT NULL)
);
CREATE INDEX rework_resolutions_rework_idx ON rework_resolutions (rework_id);
CREATE TRIGGER rework_resolutions_append_only BEFORE UPDATE OR DELETE ON rework_resolutions
  FOR EACH ROW EXECUTE FUNCTION reject_ledger_change();

-- ============ Earnings and costs ============

-- A receipt pays every member of the team, so "once" is per person per source.
ALTER TABLE karigar_ledger DROP CONSTRAINT karigar_ledger_source_type_check;
ALTER TABLE karigar_ledger ADD CONSTRAINT karigar_ledger_source_type_check
  CHECK (source_type IN ('CUTTING', 'STITCHING', 'REWORK'));
ALTER TABLE karigar_ledger DROP CONSTRAINT karigar_ledger_once;
ALTER TABLE karigar_ledger ADD CONSTRAINT karigar_ledger_once UNIQUE (source_type, source_id, karigar_id, type);

-- Stitching labour is a lot cost too; its source is a receipt or a rework resolution.
ALTER TABLE lot_costs ALTER COLUMN batch_id DROP NOT NULL;
ALTER TABLE lot_costs ADD COLUMN source_id uuid;
-- Existing rows are cutting costs whose source is their batch. The append-only
-- trigger is lifted for this one backfill only.
ALTER TABLE lot_costs DISABLE TRIGGER lot_costs_append_only;
UPDATE lot_costs SET source_id = batch_id;
ALTER TABLE lot_costs ENABLE TRIGGER lot_costs_append_only;
ALTER TABLE lot_costs ALTER COLUMN source_id SET NOT NULL;
ALTER TABLE lot_costs DROP CONSTRAINT lot_costs_kind_check;
ALTER TABLE lot_costs ADD CONSTRAINT lot_costs_kind_check
  CHECK (kind IN ('FABRIC_CONSUMED', 'FABRIC_WASTAGE', 'CUTTING_LABOUR', 'STITCHING_LABOUR'));
ALTER TABLE lot_costs ADD CONSTRAINT lot_costs_batch_link CHECK ((kind = 'STITCHING_LABOUR') = (batch_id IS NULL));
DROP INDEX lot_costs_once_idx;
CREATE UNIQUE INDEX lot_costs_once_idx ON lot_costs (source_id, kind) WHERE reversal_of IS NULL;
