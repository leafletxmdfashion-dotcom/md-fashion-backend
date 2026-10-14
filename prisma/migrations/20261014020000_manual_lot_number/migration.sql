-- Lot numbers are typed by the cutting operator instead of being generated.
-- Existing lots keep the number they were given. Uniqueness ignores case and
-- surrounding spaces, so "lot-12" and "LOT-12 " are the same lot.
ALTER TABLE production_lots DROP COLUMN search_text;
ALTER TABLE production_lots ALTER COLUMN lot_number DROP EXPRESSION;
ALTER TABLE production_lots ALTER COLUMN lot_number SET NOT NULL;
ALTER TABLE production_lots ADD CONSTRAINT production_lots_lot_number_check
  CHECK (char_length(btrim(lot_number)) BETWEEN 1 AND 30);
ALTER TABLE production_lots DROP COLUMN lot_year, DROP COLUMN lot_seq;
ALTER TABLE production_lots ADD COLUMN lot_key text GENERATED ALWAYS AS (lower(btrim(lot_number))) STORED;
ALTER TABLE production_lots ADD CONSTRAINT production_lots_lot_key_unique UNIQUE (lot_key);
ALTER TABLE production_lots ADD COLUMN search_text text GENERATED ALWAYS AS (
  lower(lot_number || ' ' || article_code || ' ' || article_name)
) STORED;
CREATE INDEX production_lots_search_idx ON production_lots USING gin (search_text gin_trgm_ops);
CREATE INDEX production_lots_date_idx ON production_lots (production_date DESC, created_at DESC);
