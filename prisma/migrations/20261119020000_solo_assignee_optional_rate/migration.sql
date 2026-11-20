-- 1. Stitching work can go to one karigar instead of a team.
ALTER TABLE stitching_issues ALTER COLUMN team_id DROP NOT NULL;
ALTER TABLE stitching_issues ADD COLUMN karigar_id uuid REFERENCES karigars (id);
ALTER TABLE stitching_issues ADD CONSTRAINT stitching_issues_assignee_check CHECK (num_nonnulls(team_id, karigar_id) = 1);
CREATE INDEX stitching_issues_karigar_idx ON stitching_issues (karigar_id) WHERE karigar_id IS NOT NULL;

-- 2. The rate per piece may be left blank and set later ("rate pending"). While it is blank nothing is paid;
--    setting it pays everything received so far. Packing keeps earning 0 until then.
ALTER TABLE stitching_issues ALTER COLUMN rate DROP NOT NULL;
ALTER TABLE packing_entries ALTER COLUMN rate DROP NOT NULL;
ALTER TABLE packing_entries ADD CONSTRAINT packing_entries_pending_rate_check CHECK (rate IS NOT NULL OR earning = 0);

-- 3. Every rate set or changed after work was paid. A change posts only the difference for pieces already paid,
--    as ledger rows and a labour cost with source RATE_CHANGE / this row's id. Append-only.
CREATE TABLE rate_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number integer GENERATED ALWAYS AS IDENTITY UNIQUE,
  source_type text NOT NULL CHECK (source_type IN ('STITCHING_ISSUE', 'PACKING_ENTRY')),
  source_id uuid NOT NULL,
  lot_id uuid NOT NULL REFERENCES production_lots (id),
  old_rate numeric(12, 2) CHECK (old_rate >= 0),
  new_rate numeric(12, 2) NOT NULL CHECK (new_rate >= 0),
  -- Pieces already paid that the difference applies to.
  pieces integer NOT NULL CHECK (pieces >= 0),
  -- Total posted by this change (+ more pay, − less pay).
  amount numeric(14, 2) NOT NULL,
  reason text CHECK (char_length(reason) <= 300),
  created_by uuid NOT NULL REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX rate_changes_source_idx ON rate_changes (source_type, source_id, created_at);
CREATE TRIGGER rate_changes_append_only BEFORE UPDATE OR DELETE ON rate_changes
  FOR EACH ROW EXECUTE FUNCTION reject_ledger_change();

ALTER TABLE karigar_ledger DROP CONSTRAINT karigar_ledger_source_type_check;
ALTER TABLE karigar_ledger ADD CONSTRAINT karigar_ledger_source_type_check
  CHECK (source_type IN ('CUTTING', 'STITCHING', 'REWORK', 'PACKING', 'MANUAL', 'RATE_CHANGE'));
