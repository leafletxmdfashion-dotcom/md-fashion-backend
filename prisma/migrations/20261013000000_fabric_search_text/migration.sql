-- Fabric search moves from an expression index (which Prisma cannot describe) to a
-- generated column with a trigram index, like fabric_inwards.search_text.
DROP INDEX fabrics_search_idx;
ALTER TABLE fabrics ADD COLUMN search_text text GENERATED ALWAYS AS (lower(name || ' ' || code)) STORED;
CREATE INDEX fabrics_search_idx ON fabrics USING gin (search_text gin_trgm_ops);
