-- Production: karigars and their earnings ledger, articles (items / designs), size
-- templates, production lots and weight-based cutting. Cutting moves fabric out of
-- the store through the existing fabric ledger and tracks it through cutting
-- (in progress → consumed / wastage / returned) in its own append-only ledger.

-- Workers. Pay mode decides what a finalized cutting job earns them.
CREATE TABLE karigars (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number integer GENERATED ALWAYS AS IDENTITY UNIQUE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  phone text CHECK (char_length(phone) <= 20),
  category text NOT NULL CHECK (category IN ('CUTTING_MASTER', 'TAILOR', 'HELPER', 'OTHER')),
  pay_mode text NOT NULL CHECK (pay_mode IN ('PER_PIECE', 'PER_PALA', 'PER_KG', 'FIXED_JOB', 'SALARY')),
  pay_rate numeric(12, 2) NOT NULL DEFAULT 0 CHECK (pay_rate >= 0),
  active boolean NOT NULL DEFAULT true,
  notes text CHECK (char_length(notes) <= 500),
  search_text text GENERATED ALWAYS AS (lower(name || ' ' || COALESCE(phone, ''))) STORED,
  created_by uuid NOT NULL REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX karigars_search_idx ON karigars USING gin (search_text gin_trgm_ops);

-- Person ledger: earnings posted by production documents. One earning per source
-- document; a correction posts a linked negative reversal, never an edit.
CREATE TABLE karigar_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  karigar_id uuid NOT NULL REFERENCES karigars (id),
  entry_date date NOT NULL,
  type text NOT NULL CHECK (type IN ('EARNING', 'EARNING_REVERSAL')),
  pay_mode text NOT NULL,
  quantity numeric(18, 6) NOT NULL,
  rate numeric(12, 2) NOT NULL,
  amount numeric(14, 2) NOT NULL,
  source_type text NOT NULL CHECK (source_type IN ('CUTTING')),
  source_id uuid NOT NULL,
  description text NOT NULL,
  created_by uuid NOT NULL REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT karigar_ledger_sign CHECK ((type = 'EARNING') = (amount >= 0)),
  CONSTRAINT karigar_ledger_once UNIQUE (source_type, source_id, type)
);
CREATE INDEX karigar_ledger_karigar_idx ON karigar_ledger (karigar_id, entry_date);
CREATE TRIGGER karigar_ledger_append_only BEFORE UPDATE OR DELETE ON karigar_ledger
  FOR EACH ROW EXECUTE FUNCTION reject_ledger_change();

-- Items / designs. name_key ignores case, spacing and punctuation, so "Polo T-Shirt"
-- and "polo tshirt" cannot both exist.
CREATE TABLE articles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9][A-Z0-9-]{0,23}$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  name_key text GENERATED ALWAYS AS (lower(regexp_replace(name, '[^[:alnum:]]+', '', 'g'))) STORED,
  default_fabric_id uuid REFERENCES fabrics (id),
  -- Reusable cutting defaults (measurements and size ratio), validated by the API.
  default_marker jsonb,
  active boolean NOT NULL DEFAULT true,
  search_text text GENERATED ALWAYS AS (lower(code || ' ' || name)) STORED,
  created_by uuid NOT NULL REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT articles_name_key_unique UNIQUE (name_key)
);
CREATE INDEX articles_search_idx ON articles USING gin (search_text gin_trgm_ops);

CREATE TABLE size_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 50),
  name_key text GENERATED ALWAYS AS (lower(btrim(name))) STORED,
  sizes text[] NOT NULL CHECK (cardinality(sizes) BETWEEN 1 AND 20),
  created_by uuid NOT NULL REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT size_templates_name_key_unique UNIQUE (name_key)
);

-- A production lot: one article cut from one fabric, numbered LOT-<year>-<seq>.
-- The article's code and name are snapshotted so renaming the article later
-- does not rewrite history.
CREATE TABLE production_lots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lot_year integer NOT NULL CHECK (lot_year BETWEEN 2000 AND 9999),
  lot_seq integer NOT NULL CHECK (lot_seq > 0),
  lot_number text GENERATED ALWAYS AS ('LOT-' || lot_year::text || '-' || lpad(lot_seq::text, 4, '0')) STORED,
  article_id uuid NOT NULL REFERENCES articles (id),
  article_code text NOT NULL,
  article_name text NOT NULL,
  fabric_id uuid NOT NULL REFERENCES fabrics (id),
  production_date date NOT NULL,
  target_quantity integer CHECK (target_quantity BETWEEN 1 AND 10000000),
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'ACTIVE', 'COMPLETED', 'CANCELLED')),
  notes text CHECK (char_length(notes) <= 500),
  search_text text GENERATED ALWAYS AS (
    lower('lot-' || lot_year::text || '-' || lpad(lot_seq::text, 4, '0') || ' ' || article_code || ' ' || article_name)
  ) STORED,
  created_by uuid NOT NULL REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT production_lots_number_unique UNIQUE (lot_year, lot_seq)
);
CREATE INDEX production_lots_date_idx ON production_lots (production_date DESC, lot_year DESC, lot_seq DESC);
CREATE INDEX production_lots_search_idx ON production_lots USING gin (search_text gin_trgm_ops);

-- One cutting job of a lot with one marker (measurements + size ratio). Marker
-- values are the batch's own snapshot; the posting totals are written once, when
-- the batch is finalized.
CREATE TABLE cutting_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number integer GENERATED ALWAYS AS IDENTITY UNIQUE,
  lot_id uuid NOT NULL REFERENCES production_lots (id),
  cutting_master_id uuid REFERENCES karigars (id),
  cutting_date date NOT NULL,
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'ISSUED', 'FINALIZED', 'REVERSED')),
  notes text CHECK (char_length(notes) <= 500),
  width_m numeric(10, 4) CHECK (width_m > 0),
  length_m numeric(10, 4) CHECK (length_m > 0),
  gsm numeric(10, 2) CHECK (gsm > 0),
  measured_pala_kg numeric(18, 6) CHECK (measured_pala_kg > 0),
  weight_source text NOT NULL DEFAULT 'MEASURED' CHECK (weight_source IN ('MEASURED', 'CALCULATED')),
  repetitions_per_layer integer NOT NULL DEFAULT 1 CHECK (repetitions_per_layer BETWEEN 1 AND 50),
  calculation_version integer,
  calculated_pala_kg numeric(18, 6),
  active_pala_kg numeric(18, 6),
  total_issued_kg numeric(18, 6),
  total_returned_kg numeric(18, 6),
  total_consumed_kg numeric(18, 6),
  total_wastage_kg numeric(18, 6),
  total_pala integer,
  total_planned_pieces integer,
  total_accepted_pieces integer,
  fabric_cost numeric(14, 2),
  earning_amount numeric(14, 2),
  finalized_by uuid REFERENCES users (id),
  finalized_at timestamptz,
  reversed_by uuid REFERENCES users (id),
  reversed_at timestamptz,
  reversal_reason text CHECK (char_length(reversal_reason) <= 500),
  created_by uuid NOT NULL REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cutting_batches_posted CHECK (
    (status IN ('FINALIZED', 'REVERSED')) = (finalized_at IS NOT NULL AND calculation_version IS NOT NULL
      AND active_pala_kg IS NOT NULL AND total_issued_kg IS NOT NULL)
  ),
  CONSTRAINT cutting_batches_reconciled CHECK (
    finalized_at IS NULL OR total_issued_kg = total_consumed_kg + total_returned_kg + total_wastage_kg
  ),
  CONSTRAINT cutting_batches_reversal_complete CHECK ((status = 'REVERSED') = (reversed_at IS NOT NULL))
);
CREATE INDEX cutting_batches_lot_idx ON cutting_batches (lot_id, number);
CREATE INDEX cutting_batches_date_idx ON cutting_batches (cutting_date DESC, number DESC);

CREATE TABLE cutting_sizes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES cutting_batches (id) ON DELETE CASCADE,
  position integer NOT NULL,
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 20),
  pieces_per_pala integer NOT NULL CHECK (pieces_per_pala BETWEEN 1 AND 999),
  piece_weight_g numeric(10, 3) CHECK (piece_weight_g > 0)
);
CREATE UNIQUE INDEX cutting_sizes_label_idx ON cutting_sizes (batch_id, lower(label));

CREATE TABLE cutting_colours (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES cutting_batches (id) ON DELETE CASCADE,
  position integer NOT NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 50)
);
CREATE UNIQUE INDEX cutting_colours_name_idx ON cutting_colours (batch_id, lower(name));

-- One Thaan (roll) cut under the batch marker. Issue moves its weight from the
-- fabric store into cutting; finalizing splits it into consumed, returned and
-- wastage, which must add back up to the issued weight.
CREATE TABLE cutting_rolls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES cutting_batches (id) ON DELETE CASCADE,
  colour_id uuid NOT NULL REFERENCES cutting_colours (id) ON DELETE CASCADE,
  position integer NOT NULL,
  thaan text NOT NULL CHECK (char_length(thaan) BETWEEN 1 AND 50),
  issued_kg numeric(18, 6) NOT NULL CHECK (issued_kg > 0),
  returned_kg numeric(18, 6) NOT NULL DEFAULT 0 CHECK (returned_kg >= 0 AND returned_kg <= issued_kg),
  confirmed_layers integer CHECK (confirmed_layers >= 0),
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'ISSUED', 'FINALIZED', 'REVERSED')),
  fabric_rate numeric(14, 4),
  issued_at timestamptz,
  estimated_pala integer,
  confirmed_pala integer,
  consumed_kg numeric(18, 6),
  wastage_kg numeric(18, 6),
  CONSTRAINT cutting_rolls_issued CHECK ((status = 'DRAFT') = (issued_at IS NULL)),
  CONSTRAINT cutting_rolls_reconciled CHECK (
    status NOT IN ('FINALIZED', 'REVERSED')
    OR (consumed_kg >= 0 AND wastage_kg >= 0 AND confirmed_pala >= 0
        AND issued_kg = consumed_kg + returned_kg + wastage_kg)
  )
);
CREATE INDEX cutting_rolls_batch_idx ON cutting_rolls (batch_id, position);
CREATE UNIQUE INDEX cutting_rolls_thaan_idx ON cutting_rolls (batch_id, lower(thaan));

-- Cut pieces rejected while cutting, entered before finalizing.
CREATE TABLE cutting_rejects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES cutting_batches (id) ON DELETE CASCADE,
  colour_id uuid NOT NULL REFERENCES cutting_colours (id) ON DELETE CASCADE,
  size_label text NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 200)
);
CREATE UNIQUE INDEX cutting_rejects_size_idx ON cutting_rejects (batch_id, colour_id, lower(size_label));

-- Size-wise output per colour, posted when a batch is finalized. Only accepted
-- pieces become available to stitching; stitching will draw this down.
CREATE TABLE cutting_outputs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES cutting_batches (id),
  lot_id uuid NOT NULL REFERENCES production_lots (id),
  colour_id uuid NOT NULL REFERENCES cutting_colours (id),
  colour_name text NOT NULL,
  size_label text NOT NULL,
  position integer NOT NULL,
  planned_quantity integer NOT NULL CHECK (planned_quantity >= 0),
  rejected_quantity integer NOT NULL CHECK (rejected_quantity >= 0),
  accepted_quantity integer NOT NULL CHECK (accepted_quantity >= 0),
  available_for_stitching integer NOT NULL CHECK (available_for_stitching BETWEEN 0 AND accepted_quantity),
  reject_reason text,
  CONSTRAINT cutting_outputs_balanced CHECK (accepted_quantity = planned_quantity - rejected_quantity),
  CONSTRAINT cutting_outputs_once UNIQUE (batch_id, colour_id, size_label)
);
CREATE INDEX cutting_outputs_lot_idx ON cutting_outputs (lot_id);

-- The cutting ledger: every kilogram moving between inventory states.
--   ISSUE   STORE → CUTTING      RETURN  CUTTING → STORE
--   CONSUME CUTTING → CONSUMED   WASTAGE CUTTING → WASTAGE
-- A reversal row points at the movement it undoes and runs the other way.
CREATE TABLE cutting_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  batch_id uuid NOT NULL REFERENCES cutting_batches (id),
  lot_id uuid NOT NULL REFERENCES production_lots (id),
  fabric_id uuid NOT NULL REFERENCES fabrics (id),
  roll_id uuid NOT NULL REFERENCES cutting_rolls (id),
  colour text NOT NULL,
  thaan text NOT NULL,
  movement_date date NOT NULL,
  type text NOT NULL CHECK (type IN ('ISSUE', 'RETURN', 'CONSUME', 'WASTAGE')),
  from_state text NOT NULL CHECK (from_state IN ('STORE', 'CUTTING', 'CONSUMED', 'WASTAGE')),
  to_state text NOT NULL CHECK (to_state IN ('STORE', 'CUTTING', 'CONSUMED', 'WASTAGE')),
  quantity numeric(18, 6) NOT NULL CHECK (quantity > 0),
  unit text NOT NULL DEFAULT 'KG' CHECK (unit = 'KG'),
  wastage_type text CHECK (wastage_type = 'AUTO_PALA_REMAINDER'),
  reversal_of uuid UNIQUE REFERENCES cutting_movements (id),
  reason text,
  created_by uuid NOT NULL REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cutting_movements_states CHECK (from_state <> to_state),
  CONSTRAINT cutting_movements_wastage_type CHECK ((wastage_type IS NOT NULL) = (type = 'WASTAGE' AND reversal_of IS NULL))
);
CREATE INDEX cutting_movements_batch_idx ON cutting_movements (batch_id, seq);
CREATE INDEX cutting_movements_lot_idx ON cutting_movements (lot_id, seq);
CREATE TRIGGER cutting_movements_append_only BEFORE UPDATE OR DELETE ON cutting_movements
  FOR EACH ROW EXECUTE FUNCTION reject_ledger_change();

-- Manufacturing cost entries per lot, linked to the document that caused them.
CREATE TABLE lot_costs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  lot_id uuid NOT NULL REFERENCES production_lots (id),
  batch_id uuid NOT NULL REFERENCES cutting_batches (id),
  kind text NOT NULL CHECK (kind IN ('FABRIC_CONSUMED', 'FABRIC_WASTAGE', 'CUTTING_LABOUR')),
  entry_date date NOT NULL,
  quantity numeric(18, 6) NOT NULL,
  rate numeric(14, 4) NOT NULL,
  amount numeric(14, 2) NOT NULL,
  reversal_of uuid UNIQUE REFERENCES lot_costs (id),
  created_by uuid NOT NULL REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX lot_costs_once_idx ON lot_costs (batch_id, kind) WHERE reversal_of IS NULL;
CREATE INDEX lot_costs_lot_idx ON lot_costs (lot_id, seq);
CREATE TRIGGER lot_costs_append_only BEFORE UPDATE OR DELETE ON lot_costs
  FOR EACH ROW EXECUTE FUNCTION reject_ledger_change();

-- Fabric issued to cutting leaves the store through the existing fabric ledger,
-- and returns come back through it, each linked to its cutting batch.
ALTER TABLE fabric_movements DROP CONSTRAINT fabric_movements_type_check;
ALTER TABLE fabric_movements ADD CONSTRAINT fabric_movements_type_check CHECK (type IN (
  'PURCHASE_IN', 'PURCHASE_REVERSAL', 'ADJUSTMENT_IN', 'ADJUSTMENT_OUT', 'CUTTING_ISSUE', 'CUTTING_RETURN'
));
ALTER TABLE fabric_movements ADD COLUMN cutting_batch_id uuid REFERENCES cutting_batches (id);
ALTER TABLE fabric_movements ADD CONSTRAINT fabric_movements_cutting_link
  CHECK ((type IN ('CUTTING_ISSUE', 'CUTTING_RETURN')) = (cutting_batch_id IS NOT NULL));

INSERT INTO role_permissions (role_id, permission)
SELECT r.id, p.permission
FROM roles r
JOIN (VALUES
  ('OWNER', 'production.view'), ('OWNER', 'production.manage'), ('OWNER', 'cutting.issue'),
  ('OWNER', 'cutting.finalize'), ('OWNER', 'cutting.reverse'), ('OWNER', 'karigar.view'),
  ('OWNER', 'karigar.manage'), ('OWNER', 'costing.view'),
  ('ADMIN', 'production.view'), ('ADMIN', 'production.manage'), ('ADMIN', 'cutting.issue'),
  ('ADMIN', 'cutting.finalize'), ('ADMIN', 'cutting.reverse'), ('ADMIN', 'karigar.view'),
  ('ADMIN', 'karigar.manage'), ('ADMIN', 'costing.view'),
  ('MANAGER', 'production.view'), ('MANAGER', 'production.manage'), ('MANAGER', 'cutting.issue'),
  ('MANAGER', 'cutting.finalize'), ('MANAGER', 'karigar.view'), ('MANAGER', 'karigar.manage'),
  ('MANAGER', 'costing.view'),
  ('STAFF', 'production.view'), ('STAFF', 'production.manage'), ('STAFF', 'cutting.issue'),
  ('STAFF', 'karigar.view'),
  ('VIEWER', 'production.view'), ('VIEWER', 'karigar.view')
) AS p (role_key, permission) ON p.role_key = r.key;
