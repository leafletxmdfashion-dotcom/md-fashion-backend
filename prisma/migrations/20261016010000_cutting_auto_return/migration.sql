-- A Thaan's returned weight is worked out on finalize unless the operator enters
-- it: NULL means "not entered". Finalizing always stores the posted figure.
ALTER TABLE cutting_rolls ALTER COLUMN returned_kg DROP NOT NULL, ALTER COLUMN returned_kg DROP DEFAULT;

-- Open Thaan saved with the old blank-means-zero return now take the automatic figure.
UPDATE cutting_rolls SET returned_kg = NULL WHERE status IN ('DRAFT', 'ISSUED') AND returned_kg = 0;

ALTER TABLE cutting_rolls DROP CONSTRAINT cutting_rolls_reconciled;
ALTER TABLE cutting_rolls ADD CONSTRAINT cutting_rolls_reconciled CHECK (
  status NOT IN ('FINALIZED', 'REVERSED')
  OR (consumed_kg >= 0 AND wastage_kg >= 0 AND confirmed_pala >= 0 AND returned_kg IS NOT NULL
      AND issued_kg = consumed_kg + returned_kg + wastage_kg)
);
