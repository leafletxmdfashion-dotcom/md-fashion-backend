-- Supplies arrive in bulk, so purchases carry no colour or than/roll; cutting will record them.
-- search_text is generated from colour and roll, so rebuild it (and its index) without them.
ALTER TABLE fabric_inwards DROP COLUMN search_text;
ALTER TABLE fabric_inwards DROP COLUMN color, DROP COLUMN roll_ref;
ALTER TABLE fabric_inwards ADD COLUMN search_text text GENERATED ALWAYS AS (
  lower(COALESCE(supplier, '') || ' ' || COALESCE(invoice_ref, ''))
) STORED;
CREATE INDEX fabric_inwards_search_idx ON fabric_inwards USING gin (search_text gin_trgm_ops);

ALTER TABLE fabric_movements DROP COLUMN color, DROP COLUMN roll_ref;
