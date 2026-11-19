-- What a person works as now mirrors the system's job roles (Roles screen), so the category and the
-- login role they usually get line up. Owner, Admin and Viewer are login roles, not jobs. Old values
-- are mapped onto the role they belong to.
ALTER TABLE karigars DROP CONSTRAINT karigars_category_check;

UPDATE karigars SET category = CASE category
  WHEN 'TAILOR' THEN 'KARIGAR'
  WHEN 'HELPER' THEN 'KARIGAR'
  WHEN 'CUTTING_HELPER' THEN 'KARIGAR'
  WHEN 'OVERLOCK' THEN 'KARIGAR'
  WHEN 'KAJ_BUTTON' THEN 'KARIGAR'
  WHEN 'FINISHER' THEN 'KARIGAR'
  WHEN 'CHECKER' THEN 'KARIGAR'
  WHEN 'IRONING' THEN 'KARIGAR'
  WHEN 'DRIVER' THEN 'KARIGAR'
  WHEN 'PACKER' THEN 'PACKING_STAFF'
  WHEN 'PRODUCTION_MANAGER' THEN 'MANAGER'
  WHEN 'SUPERVISOR' THEN 'STITCHING_SUPERVISOR'
  ELSE category
END;

ALTER TABLE karigars ADD CONSTRAINT karigars_category_check CHECK (category IN (
  'KARIGAR', 'CUTTING_MASTER', 'STITCHING_SUPERVISOR', 'PACKING_STAFF', 'GODOWN_STAFF', 'STORE_KEEPER',
  'MANAGER', 'ACCOUNTANT', 'STAFF', 'OTHER'
));
