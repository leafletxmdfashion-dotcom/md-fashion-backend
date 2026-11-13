-- The Pala measured in the other unit (metres for kg fabric, kg for metre fabric).
-- Recorded for reference only; the cutting calculation uses measured_pala_kg.
ALTER TABLE cutting_batches ADD COLUMN pala_alt_value numeric(18, 6);
ALTER TABLE cutting_batches ADD CONSTRAINT cutting_batches_pala_alt_value_positive CHECK (pala_alt_value IS NULL OR pala_alt_value > 0);

-- Restore the indexes dropped by 20261113090324 (they were missing from schema.prisma, so
-- prisma migrate dev treated them as drift). They are now declared in the schema.
CREATE INDEX IF NOT EXISTS karigar_ledger_date_idx ON karigar_ledger (entry_date DESC, seq DESC);
CREATE INDEX IF NOT EXISTS godown_movements_dispatch_idx ON godown_movements (dispatch_id) WHERE dispatch_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS godown_movements_packing_idx ON godown_movements (packing_entry_id) WHERE packing_entry_id IS NOT NULL;
