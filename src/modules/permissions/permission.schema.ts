import { z } from "zod";

import { roleKeySchema } from "../users/user.schema";
import { isPermission } from "./permission.types";

export const roleKeyParamsSchema = z.object({ roleKey: roleKeySchema });

export const updateRolePermissionsSchema = z.strictObject({
  permissions: z
    .array(z.string().refine(isPermission, "Unknown permission."))
    .max(100)
    .transform((permissions) => [...new Set(permissions)].filter(isPermission)),
});
