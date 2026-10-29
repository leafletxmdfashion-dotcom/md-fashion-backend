-- Job roles from the client's list, an optional note per Thaan (why its Pala differ
-- from the weight estimate), and removal of the size template and item master screens
-- (sizes and items are entered on the cutting form).

ALTER TABLE cutting_rolls ADD COLUMN note text CHECK (char_length(note) <= 200);

DROP TABLE size_templates;

-- Item create/edit now happens only through cutting (production.manage).
DELETE FROM role_permissions WHERE permission = 'items.manage';

UPDATE roles SET name = 'Production Manager' WHERE key = 'MANAGER';

INSERT INTO roles (key, name, rank) VALUES
  ('ACCOUNTANT', 'Accountant', 45),
  ('STITCHING_SUPERVISOR', 'Stitching Supervisor', 45),
  ('CUTTING_MASTER', 'Cutting Master', 40),
  ('STORE_KEEPER', 'Store Keeper', 40),
  ('PACKING_STAFF', 'Packing Staff', 30),
  ('GODOWN_STAFF', 'Godown Staff', 30)
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission)
SELECT r.id, p.permission
FROM roles r
JOIN (VALUES
  ('ACCOUNTANT', 'dashboard.view'), ('ACCOUNTANT', 'fabric.view'), ('ACCOUNTANT', 'production.view'),
  ('ACCOUNTANT', 'stitching.view'), ('ACCOUNTANT', 'karigar.view'), ('ACCOUNTANT', 'costing.view'),

  ('STITCHING_SUPERVISOR', 'dashboard.view'), ('STITCHING_SUPERVISOR', 'production.view'),
  ('STITCHING_SUPERVISOR', 'stitching.view'), ('STITCHING_SUPERVISOR', 'stitching.issue'),
  ('STITCHING_SUPERVISOR', 'stitching.receive'), ('STITCHING_SUPERVISOR', 'stitching.rework'),
  ('STITCHING_SUPERVISOR', 'karigar.view'), ('STITCHING_SUPERVISOR', 'karigar.manage'),

  ('CUTTING_MASTER', 'dashboard.view'), ('CUTTING_MASTER', 'fabric.view'), ('CUTTING_MASTER', 'production.view'),
  ('CUTTING_MASTER', 'production.manage'), ('CUTTING_MASTER', 'cutting.issue'), ('CUTTING_MASTER', 'karigar.view'),

  ('STORE_KEEPER', 'dashboard.view'), ('STORE_KEEPER', 'fabric.view'), ('STORE_KEEPER', 'fabric.inward'),
  ('STORE_KEEPER', 'fabric.manage'),

  ('PACKING_STAFF', 'dashboard.view'), ('PACKING_STAFF', 'production.view'), ('PACKING_STAFF', 'stitching.view'),

  ('GODOWN_STAFF', 'dashboard.view'), ('GODOWN_STAFF', 'fabric.view'), ('GODOWN_STAFF', 'production.view'),
  ('GODOWN_STAFF', 'stitching.view')
) AS p (role_key, permission) ON p.role_key = r.key
ON CONFLICT DO NOTHING;
