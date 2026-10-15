-- Rejected pieces are no longer recorded at cutting: every cut piece is output.
-- Already-finalized outputs keep their accepted quantity as posted.
DROP TABLE cutting_rejects;
ALTER TABLE cutting_outputs DROP CONSTRAINT cutting_outputs_balanced;
ALTER TABLE cutting_outputs DROP COLUMN rejected_quantity, DROP COLUMN reject_reason;

-- A marker may leave a size out (0 pieces per Pala); the API still requires at
-- least one size with pieces.
ALTER TABLE cutting_sizes DROP CONSTRAINT cutting_sizes_pieces_per_pala_check;
ALTER TABLE cutting_sizes ADD CONSTRAINT cutting_sizes_pieces_per_pala_check CHECK (pieces_per_pala BETWEEN 0 AND 999);
