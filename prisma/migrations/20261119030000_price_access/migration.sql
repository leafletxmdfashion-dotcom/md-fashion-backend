-- Prices and costs are sensitive: by default only Owner and Admin see them. The owner can give
-- "See prices & costs" back to any role (Roles screen) or to one person (access overrides).
DELETE FROM role_permissions
WHERE permission = 'costing.view'
  AND role_id NOT IN (SELECT id FROM roles WHERE key IN ('OWNER', 'ADMIN'));

-- New: set a pending rate per piece, or change one after work was paid.
INSERT INTO role_permissions (role_id, permission)
SELECT id, 'rates.manage' FROM roles WHERE key IN ('OWNER', 'ADMIN')
ON CONFLICT DO NOTHING;
