import { z } from "zod";

import { emailSchema, nameSchema, phoneSchema } from "../auth/auth.schema";
import { PASSWORD_MAX_LENGTH } from "../auth/password";

export const roleKeySchema = z.string({ error: "Role is required." }).regex(/^[A-Z][A-Z_]{1,31}$/, "Unknown role.");

export const userIdParamsSchema = z.object({ userId: z.uuid() });

/** Blank or missing → null; anything else must pass `schema`. */
const blankToNull = <T extends z.ZodType>(schema: T) =>
  z
    .preprocess(
      (value) => (value === undefined || (typeof value === "string" && value.trim() === "") ? null : value),
      schema.nullable(),
    )
    .optional()
    .transform((value) => value ?? null);

// Policy (length, common, matches email/phone/name) is checked by the service with full context.
const chosenPasswordSchema = z
  .string({ error: "Enter a password." })
  .min(1, "Enter a password.")
  .max(PASSWORD_MAX_LENGTH, `Use at most ${PASSWORD_MAX_LENGTH} characters.`);

const loginFields = {
  email: blankToNull(emailSchema),
  phone: blankToNull(phoneSchema),
  roleKey: roleKeySchema,
  mode: z.enum(["INVITE", "PASSWORD"], { error: "Choose how they get their password." }).default("INVITE"),
  password: chosenPasswordSchema.optional(),
};

function refineLogin(
  input: { email: string | null; phone: string | null; mode: "INVITE" | "PASSWORD"; password?: string | undefined },
  ctx: z.RefinementCtx,
) {
  if (!input.email && !input.phone) {
    ctx.addIssue({ code: "custom", path: ["email"], message: "Enter an email or a phone number." });
  }
  if (input.mode === "PASSWORD" && !input.password) {
    ctx.addIssue({ code: "custom", path: ["password"], message: "Enter a password." });
  }
  if (input.mode === "INVITE" && input.password !== undefined) {
    ctx.addIssue({ code: "custom", path: ["password"], message: "An invited person sets their own password." });
  }
}

/**
 * A login: email or phone (at least one), a role, and either an invitation link (they choose the
 * password) or a password the admin sets and hands over (changed at the first sign-in).
 */
export const newLoginSchema = z.strictObject({ name: nameSchema, ...loginFields }).superRefine(refineLogin);

/** The same login created with a staff / karigar record; the name is the person's. */
export const personLoginSchema = z.strictObject(loginFields).superRefine(refineLogin);

export type NewLogin = z.infer<typeof newLoginSchema>;

/** Kept for the Users page; same shape as a person's login. */
export const createInvitationSchema = newLoginSchema;

export const setPasswordSchema = z.strictObject({ password: chosenPasswordSchema });

export const updateUserSchema = z.strictObject({ name: nameSchema });

export const changeRoleSchema = z.strictObject({ roleKey: roleKeySchema });
