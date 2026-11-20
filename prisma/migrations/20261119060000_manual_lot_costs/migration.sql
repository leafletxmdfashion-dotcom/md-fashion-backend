-- Lot costs added by hand (Costing page): accessories, printing/embroidery/washing, other direct costs.
-- Each carries what it is for (note, required) and an optional bill/voucher reference. Removing one
-- posts a reversal row, as for every other lot cost; automatic kinds are never added by hand.
ALTER TABLE lot_costs DROP CONSTRAINT lot_costs_kind_check;
ALTER TABLE lot_costs ADD CONSTRAINT lot_costs_kind_check CHECK (kind IN (
  'FABRIC_CONSUMED', 'FABRIC_WASTAGE', 'CUTTING_LABOUR', 'STITCHING_LABOUR', 'PACKING_LABOUR',
  'ACCESSORIES', 'PROCESSING', 'OTHER_DIRECT'
));
ALTER TABLE lot_costs DROP CONSTRAINT lot_costs_batch_link;
ALTER TABLE lot_costs ADD CONSTRAINT lot_costs_batch_link CHECK (
  (kind IN ('STITCHING_LABOUR', 'PACKING_LABOUR', 'ACCESSORIES', 'PROCESSING', 'OTHER_DIRECT')) = (batch_id IS NULL)
);
ALTER TABLE lot_costs ADD COLUMN note text CHECK (char_length(note) <= 300);
ALTER TABLE lot_costs ADD COLUMN reference text CHECK (char_length(reference) <= 60);
ALTER TABLE lot_costs ADD CONSTRAINT lot_costs_manual_note CHECK (
  kind NOT IN ('ACCESSORIES', 'PROCESSING', 'OTHER_DIRECT') OR reversal_of IS NOT NULL OR note IS NOT NULL
);
