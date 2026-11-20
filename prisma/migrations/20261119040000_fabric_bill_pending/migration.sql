-- Fabric that arrives before its bill: received now (stock is right at once), priced when the bill comes.
-- A pending purchase has no rate, so no amount; it does not count towards the fabric's average rate.
ALTER TABLE fabric_inwards ALTER COLUMN rate DROP NOT NULL;
ALTER TABLE fabric_inwards ADD COLUMN bill_status text NOT NULL DEFAULT 'BILLED'
  CHECK (bill_status IN ('PENDING', 'BILLED'));
ALTER TABLE fabric_inwards ADD COLUMN billed_at timestamptz;
ALTER TABLE fabric_inwards ADD COLUMN billed_by uuid REFERENCES users (id);
ALTER TABLE fabric_inwards ADD CONSTRAINT fabric_inwards_bill_check CHECK ((bill_status = 'PENDING') = (rate IS NULL));
CREATE INDEX fabric_inwards_pending_idx ON fabric_inwards (fabric_id) WHERE bill_status = 'PENDING' AND reversed_at IS NULL;

-- The average rate is over billed purchases only: a pending purchase adds stock but not purchased qty/amount.
CREATE OR REPLACE FUNCTION fabric_stock_apply() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  sign integer := CASE NEW.type WHEN 'PURCHASE_IN' THEN 1 WHEN 'PURCHASE_REVERSAL' THEN -1 ELSE 0 END;
  inward_amount numeric(16, 2) := 0;
  billed boolean := false;
BEGIN
  IF sign <> 0 THEN
    SELECT amount, bill_status = 'BILLED' INTO inward_amount, billed FROM fabric_inwards WHERE id = NEW.inward_id;
  END IF;
  UPDATE fabric_stock
  SET balance = balance + NEW.qty_in - NEW.qty_out,
      movement_count = movement_count + 1,
      purchased_qty = purchased_qty + CASE WHEN billed THEN sign * (NEW.qty_in + NEW.qty_out) ELSE 0 END,
      purchased_amount = purchased_amount + CASE WHEN billed THEN sign * inward_amount ELSE 0 END
  WHERE fabric_id = NEW.fabric_id;
  RETURN NEW;
END $$;

-- When the bill is added, the purchase starts counting towards the average rate.
CREATE FUNCTION fabric_inward_billed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.bill_status = 'PENDING' AND NEW.bill_status = 'BILLED' AND NEW.reversed_at IS NULL THEN
    UPDATE fabric_stock
    SET purchased_qty = purchased_qty + NEW.quantity, purchased_amount = purchased_amount + NEW.amount
    WHERE fabric_id = NEW.fabric_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fabric_inwards_billed AFTER UPDATE OF bill_status ON fabric_inwards
  FOR EACH ROW EXECUTE FUNCTION fabric_inward_billed();

-- Cutting done while a fabric's bill was pending carries a provisional fabric cost, re-costed when the bill comes.
ALTER TABLE cutting_rolls ADD COLUMN rate_provisional boolean NOT NULL DEFAULT false;
ALTER TABLE cutting_batches ADD COLUMN cost_provisional boolean NOT NULL DEFAULT false;
