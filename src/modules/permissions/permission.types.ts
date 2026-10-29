// The permission catalog: every right that can be granted, grouped by module with
// the label and explanation the Roles screen shows. Adding a permission here makes
// it grantable; role assignments live in the role_permissions table. Owners hold
// every permission implicitly (see session.service).
export const PERMISSION_GROUPS = [
  {
    module: "General",
    permissions: [{ key: "dashboard.view", label: "View dashboard", description: "Home page figures and shortcuts." }],
  },
  {
    module: "Fabric",
    permissions: [
      { key: "fabric.view", label: "View", description: "Purchases, stock and the fabric ledger." },
      { key: "fabric.inward", label: "Add purchases", description: "Record fabric received; creates new fabrics." },
      { key: "fabric.manage", label: "Edit fabrics", description: "Rename a fabric, change its reorder level." },
      { key: "fabric.adjust", label: "Adjust stock", description: "Physical-count corrections, with a reason." },
      { key: "fabric.reverse", label: "Reverse purchases", description: "Undo a posted purchase, with a reason." },
    ],
  },
  {
    module: "Cutting",
    permissions: [
      { key: "production.view", label: "View", description: "Lots and cutting, with their items and sizes." },
      { key: "production.manage", label: "Create and edit", description: "Start cutting, save drafts, add items." },
      { key: "cutting.issue", label: "Issue fabric", description: "Take fabric out of the store for cutting." },
      { key: "cutting.finalize", label: "Finalize", description: "Post cutting: stock, pieces, cost and earning." },
      { key: "cutting.reverse", label: "Reverse", description: "Undo finalized cutting, with a reason." },
    ],
  },
  {
    module: "Stitching",
    permissions: [
      { key: "stitching.view", label: "View", description: "Stitching issues, work in progress, rework and rejects." },
      { key: "stitching.issue", label: "Issue to Jogadi", description: "Hand cut pieces to a stitching team." },
      { key: "stitching.receive", label: "Receive", description: "Record Good, Rework and Reject pieces." },
      {
        key: "stitching.rework",
        label: "Resolve rework",
        description: "Assign rework and record recovered or failed.",
      },
      { key: "stitching.reverse", label: "Reverse", description: "Undo an issue or a receipt, with a reason." },
    ],
  },
  {
    module: "Workers",
    permissions: [
      { key: "karigar.view", label: "View", description: "Karigars and Jogadi teams." },
      { key: "karigar.manage", label: "Create and edit", description: "Add karigars, Jogadi teams and members." },
    ],
  },
  {
    module: "Money",
    permissions: [
      {
        key: "costing.view",
        label: "See rates and costs",
        description: "Pay rates, earnings, fabric cost and lot cost.",
      },
    ],
  },
  {
    module: "Users & roles",
    permissions: [
      { key: "users.view", label: "View users", description: "Who has an account and their role." },
      { key: "users.manage", label: "Manage users", description: "Invite staff, change roles, disable accounts." },
      { key: "roles.manage", label: "Manage roles", description: "Create roles and choose what each can do." },
    ],
  },
] as const;

export type Permission = (typeof PERMISSION_GROUPS)[number]["permissions"][number]["key"];

export const PERMISSIONS: readonly Permission[] = PERMISSION_GROUPS.flatMap((group) =>
  group.permissions.map((permission) => permission.key),
);

// Built-in roles are seeded by migrations (job roles from the client's list). Only OWNER has special
// meaning in code: top of the hierarchy, holds everything, must never reach zero.
export const OWNER_ROLE = "OWNER";

export const BUILT_IN_ROLES: readonly string[] = [
  "OWNER",
  "ADMIN",
  "MANAGER",
  "ACCOUNTANT",
  "STITCHING_SUPERVISOR",
  "CUTTING_MASTER",
  "STORE_KEEPER",
  "STAFF",
  "PACKING_STAFF",
  "GODOWN_STAFF",
  "VIEWER",
];

/** Roles created on the Roles screen sit between Manager (60) and Staff (40). */
export const CUSTOM_ROLE_RANK = 50;

export interface RoleRef {
  key: string;
  name: string;
  rank: number;
}

export interface RoleWithPermissions extends RoleRef {
  permissions: Permission[];
}

const permissionSet: ReadonlySet<string> = new Set(PERMISSIONS);

export function isPermission(value: string): value is Permission {
  return permissionSet.has(value);
}
