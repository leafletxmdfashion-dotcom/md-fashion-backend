-- Bulk flow after stitching and a person ledger with money in and out:
--   * cutting: Panaha / layer length typed in inch or metre; fabrics bought by the metre can be cut
--     (Pala, Thaan and wastage are then in metres; the *_kg columns hold the fabric's unit)
--   * packing: Good pieces from stitching are packed per size by a packing person, paid per piece
--   * godown: finished-goods stock per item and size, in from packing, out by dispatch, adjustable
--   * karigar ledger: payments, advances, expenses, credits and money received back
--   * people: karigars and staff in one master, optionally linked to a login

-- Cutting units -------------------------------------------------------------------------------
-- Lengths stay in metres; 6 decimals keep any inch value with 2 decimals exact (1 in = 0.0254 m).
ALTER TABLE cutting_batches
  ALTER COLUMN width_m TYPE numeric(12, 6),
  ALTER COLUMN length_m TYPE numeric(12, 6),
  ADD COLUMN width_unit text NOT NULL DEFAULT 'M' CHECK (width_unit IN ('M', 'IN')),
  ADD COLUMN length_unit text NOT NULL DEFAULT 'M' CHECK (length_unit IN ('M', 'IN'));

ALTER TABLE cutting_movements DROP CONSTRAINT cutting_movements_unit_check;
ALTER TABLE cutting_movements ADD CONSTRAINT cutting_movements_unit_check CHECK (unit IN ('KG', 'METER'));

-- People ----------------------------------------------------------------------------------------
ALTER TABLE karigars DROP CONSTRAINT karigars_category_check;
ALTER TABLE karigars ADD CONSTRAINT karigars_category_check
  CHECK (category IN ('CUTTING_MASTER', 'TAILOR', 'HELPER', 'PACKER', 'STAFF', 'OTHER'));
-- The login a karigar or staff member uses to see their own ledger.
ALTER TABLE karigars ADD COLUMN user_id uuid UNIQUE REFERENCES users (id) ON DELETE SET NULL;

-- Ledger: money paid out (negative) and in (positive) next to the earnings ----------------------
--   PAYMENT   wages / salary paid            −
--   ADVANCE   advance or loan given          −
--   EXPENSE   food, travel, occasion…        −
--   CREDIT    salary, bonus, allowance owed  +
--   RECOVERY  money received back            +
--   ENTRY_REVERSAL  undoes one manual entry (opposite sign)
ALTER TABLE karigar_ledger DROP CONSTRAINT karigar_ledger_type_check;
ALTER TABLE karigar_ledger ADD CONSTRAINT karigar_ledger_type_check
  CHECK (type IN ('EARNING', 'EARNING_REVERSAL', 'PAYMENT', 'ADVANCE', 'EXPENSE', 'CREDIT', 'RECOVERY', 'ENTRY_REVERSAL'));
ALTER TABLE karigar_ledger DROP CONSTRAINT karigar_ledger_sign;
ALTER TABLE karigar_ledger ADD CONSTRAINT karigar_ledger_sign CHECK (
  CASE type
    WHEN 'EARNING' THEN amount >= 0
    WHEN 'CREDIT' THEN amount > 0
    WHEN 'RECOVERY' THEN amount > 0
    WHEN 'ENTRY_REVERSAL' THEN amount <> 0
    ELSE amount < 0
  END);
ALTER TABLE karigar_ledger DROP CONSTRAINT karigar_ledger_source_type_check;
ALTER TABLE karigar_ledger ADD CONSTRAINT karigar_ledger_source_type_check
  CHECK (source_type IN ('CUTTING', 'STITCHING', 'REWORK', 'PACKING', 'MANUAL'));
ALTER TABLE karigar_ledger
  ADD COLUMN method text CHECK (method IN ('CASH', 'BANK', 'WALLET')),
  ADD COLUMN category text CHECK (char_length(category) BETWEEN 1 AND 40),
  ADD COLUMN reference text CHECK (char_length(reference) BETWEEN 1 AND 60);
CREATE INDEX karigar_ledger_date_idx ON karigar_ledger (entry_date DESC, seq DESC);

-- Packing ---------------------------------------------------------------------------------------
CREATE TABLE packing_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number integer GENERATED ALWAYS AS IDENTITY UNIQUE,
  lot_id uuid NOT NULL REFERENCES production_lots (id),
  packer_id uuid NOT NULL REFERENCES karigars (id),
  packer_name text NOT NULL,
  pack_date date NOT NULL,
  pieces integer NOT NULL CHECK (pieces > 0),
  rate numeric(12, 2) NOT NULL CHECK (rate >= 0),
  earning numeric(14, 2) NOT NULL CHECK (earning >= 0),
  notes text CHECK (char_length(notes) <= 500),
  status text NOT NULL DEFAULT 'POSTED' CHECK (status IN ('POSTED', 'REVERSED')),
  reversed_at timestamptz,
  reversed_by uuid REFERENCES users (id),
  reversal_reason text,
  created_by uuid NOT NULL REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT packing_entries_reversal CHECK ((status = 'REVERSED') = (reversed_at IS NOT NULL AND reversal_reason IS NOT NULL))
);
CREATE INDEX packing_entries_date_idx ON packing_entries (pack_date DESC, number DESC);
CREATE INDEX packing_entries_lot_idx ON packing_entries (lot_id);
CREATE INDEX packing_entries_packer_idx ON packing_entries (packer_id, pack_date);

-- Packing labour is a lot cost, like stitching labour (no cutting batch).
ALTER TABLE lot_costs DROP CONSTRAINT lot_costs_kind_check;
ALTER TABLE lot_costs ADD CONSTRAINT lot_costs_kind_check
  CHECK (kind IN ('FABRIC_CONSUMED', 'FABRIC_WASTAGE', 'CUTTING_LABOUR', 'STITCHING_LABOUR', 'PACKING_LABOUR'));
ALTER TABLE lot_costs DROP CONSTRAINT lot_costs_batch_link;
ALTER TABLE lot_costs ADD CONSTRAINT lot_costs_batch_link
  CHECK ((kind IN ('STITCHING_LABOUR', 'PACKING_LABOUR')) = (batch_id IS NULL));

CREATE TABLE packing_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id uuid NOT NULL REFERENCES packing_entries (id),
  size_label text NOT NULL,
  position integer NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  CONSTRAINT packing_lines_once UNIQUE (entry_id, size_label)
);

-- Godown ----------------------------------------------------------------------------------------
CREATE TABLE dispatches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number integer GENERATED ALWAYS AS IDENTITY UNIQUE,
  dispatch_date date NOT NULL,
  party text NOT NULL CHECK (char_length(btrim(party)) BETWEEN 1 AND 100),
  challan text CHECK (char_length(challan) <= 40),
  pieces integer NOT NULL CHECK (pieces > 0),
  notes text CHECK (char_length(notes) <= 500),
  status text NOT NULL DEFAULT 'POSTED' CHECK (status IN ('POSTED', 'REVERSED')),
  reversed_at timestamptz,
  reversed_by uuid REFERENCES users (id),
  reversal_reason text,
  created_by uuid NOT NULL REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dispatches_reversal CHECK ((status = 'REVERSED') = (reversed_at IS NOT NULL AND reversal_reason IS NOT NULL))
);
CREATE INDEX dispatches_date_idx ON dispatches (dispatch_date DESC, number DESC);

-- The godown stock ledger: pieces per item and size. Rows are never edited, except that
-- merging two items moves rows to the item kept (article_id is the one column that may change).
CREATE TABLE godown_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  article_id uuid NOT NULL REFERENCES articles (id),
  size_label text NOT NULL CHECK (char_length(size_label) BETWEEN 1 AND 20),
  movement_date date NOT NULL,
  type text NOT NULL CHECK (type IN ('PACKED_IN', 'PACKING_REVERSAL', 'DISPATCH', 'DISPATCH_REVERSAL', 'ADJUST_IN', 'ADJUST_OUT')),
  qty_in integer NOT NULL DEFAULT 0 CHECK (qty_in >= 0),
  qty_out integer NOT NULL DEFAULT 0 CHECK (qty_out >= 0),
  lot_id uuid REFERENCES production_lots (id),
  packing_entry_id uuid REFERENCES packing_entries (id),
  dispatch_id uuid REFERENCES dispatches (id),
  reason text CHECK (char_length(reason) <= 500),
  created_by uuid NOT NULL REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT godown_movements_one_side CHECK ((qty_in > 0) <> (qty_out > 0)),
  CONSTRAINT godown_movements_source CHECK (
    (type IN ('PACKED_IN', 'PACKING_REVERSAL')) = (packing_entry_id IS NOT NULL)
    AND (type IN ('DISPATCH', 'DISPATCH_REVERSAL')) = (dispatch_id IS NOT NULL)
    AND (type NOT IN ('ADJUST_IN', 'ADJUST_OUT') OR reason IS NOT NULL))
);
CREATE INDEX godown_movements_date_idx ON godown_movements (movement_date DESC, seq DESC);
CREATE INDEX godown_movements_article_idx ON godown_movements (article_id, size_label);
CREATE INDEX godown_movements_dispatch_idx ON godown_movements (dispatch_id) WHERE dispatch_id IS NOT NULL;
CREATE INDEX godown_movements_packing_idx ON godown_movements (packing_entry_id) WHERE packing_entry_id IS NOT NULL;

CREATE FUNCTION guard_godown_movement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR (to_jsonb(NEW) - 'article_id') IS DISTINCT FROM (to_jsonb(OLD) - 'article_id') THEN
    RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER godown_movements_append_only BEFORE UPDATE OR DELETE ON godown_movements
  FOR EACH ROW EXECUTE FUNCTION guard_godown_movement();

-- Stock per item and size, kept by trigger; never below zero.
CREATE TABLE godown_stock (
  article_id uuid NOT NULL REFERENCES articles (id),
  size_label text NOT NULL,
  qty_in integer NOT NULL DEFAULT 0,
  qty_out integer NOT NULL DEFAULT 0,
  balance integer NOT NULL DEFAULT 0 CHECK (balance >= 0),
  last_movement_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (article_id, size_label)
);

CREATE FUNCTION apply_godown_movement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- A zero row first, then the update: an outgoing movement's proposed row would fail the CHECK
  -- before ON CONFLICT could merge it.
  INSERT INTO godown_stock (article_id, size_label) VALUES (NEW.article_id, NEW.size_label)
  ON CONFLICT (article_id, size_label) DO NOTHING;
  UPDATE godown_stock
    SET qty_in = qty_in + NEW.qty_in,
        qty_out = qty_out + NEW.qty_out,
        balance = balance + NEW.qty_in - NEW.qty_out,
        last_movement_at = now()
    WHERE article_id = NEW.article_id AND size_label = NEW.size_label;
  RETURN NULL;
END $$;
CREATE TRIGGER godown_movements_stock AFTER INSERT ON godown_movements
  FOR EACH ROW EXECUTE FUNCTION apply_godown_movement();

-- Permissions -----------------------------------------------------------------------------------
INSERT INTO roles (key, name, rank) VALUES ('KARIGAR', 'Karigar', 10) ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission)
SELECT r.id, p.permission
FROM roles r
JOIN (VALUES
  ('ADMIN', 'packing.view'), ('ADMIN', 'packing.manage'), ('ADMIN', 'godown.view'), ('ADMIN', 'godown.manage'),
  ('ADMIN', 'payments.view'), ('ADMIN', 'payments.manage'),

  ('MANAGER', 'packing.view'), ('MANAGER', 'packing.manage'), ('MANAGER', 'godown.view'), ('MANAGER', 'godown.manage'),

  ('ACCOUNTANT', 'packing.view'), ('ACCOUNTANT', 'godown.view'),
  ('ACCOUNTANT', 'payments.view'), ('ACCOUNTANT', 'payments.manage'),

  ('PACKING_STAFF', 'packing.view'), ('PACKING_STAFF', 'packing.manage'), ('PACKING_STAFF', 'karigar.view'),

  ('GODOWN_STAFF', 'packing.view'), ('GODOWN_STAFF', 'godown.view'), ('GODOWN_STAFF', 'godown.manage'),

  ('VIEWER', 'packing.view'), ('VIEWER', 'godown.view')
) AS p (role_key, permission) ON p.role_key = r.key
ON CONFLICT DO NOTHING;
