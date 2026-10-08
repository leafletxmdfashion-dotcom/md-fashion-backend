import { z } from "zod";

import { emailSchema, nameSchema } from "../auth/auth.schema";

export const roleKeySchema = z.string({ error: "Role is required." }).regex(/^[A-Z][A-Z_]{1,31}$/, "Unknown role.");

export const userIdParamsSchema = z.object({ userId: z.uuid() });

export const createInvitationSchema = z.strictObject({ email: emailSchema, name: nameSchema, roleKey: roleKeySchema });

export const updateUserSchema = z.strictObject({ name: nameSchema });

export const changeRoleSchema = z.strictObject({ roleKey: roleKeySchema });
