-- Fabrics are now created from the purchase form by name: the code is assigned
-- by the database and the name identifies the fabric.

-- Codes come from a sequence, so two purchases at once can never get the same one.
-- It starts after any FAB-n code already in use.
CREATE SEQUENCE fabric_code_seq;
SELECT setval('fabric_code_seq', max(substring(code FROM '^FAB-(\d{1,15})$')::bigint))
FROM fabrics HAVING max(substring(code FROM '^FAB-(\d{1,15})$')::bigint) IS NOT NULL;

-- FAB-0001 … FAB-9999, then FAB-10000 and up (never truncated).
CREATE FUNCTION next_fabric_code() RETURNS text LANGUAGE sql AS $$
  SELECT 'FAB-' || lpad(n::text, greatest(4, length(n::text)), '0') FROM nextval('fabric_code_seq') AS n
$$;

ALTER TABLE fabrics ALTER COLUMN code SET DEFAULT next_fabric_code();

-- One fabric per name, ignoring case: a purchase of an existing name adds to that fabric.
CREATE UNIQUE INDEX fabrics_name_key ON fabrics (lower(name));
