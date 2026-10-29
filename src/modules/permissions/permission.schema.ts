import { z } from "zod";

import { roleKeySchema } from "../users/user.schema";
import { isPermission } from "./permission.types";

export const roleKeyParamsSchema = z.object({ roleKey: roleKeySchema });

const permissions = z
  .array(z.string().refine(isPermission, "Unknown permission."))
  .max(100)
  .transform((list) => [...new Set(list)].filter(isPermission));

const roleName = z
  .string({ error: "Enter the role name." })
  .trim()
  .min(2, "Use at least 2 characters.")
  .max(40, "Keep the name under 40 characters.")
  .transform((value) => value.replace(/\s+/g, " "));

export const createRoleSchema = z.strictObject({ name: roleName, permissions });

export const updateRoleSchema = z.strictObject({ name: roleName.optional(), permissions });
