import { z } from "zod";

import { normalizeEmail } from "../../lib/request";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "./password";

// Strict objects reject unknown keys, so clients cannot smuggle fields (mass assignment).

export const emailSchema = z
  .string({ error: "Email is required." })
  .trim()
  .min(1, "Email is required.")
  .max(254, "Email is too long.")
  .transform(normalizeEmail)
  .pipe(z.email("Enter a valid email address."));

export const newPasswordSchema = z
  .string({ error: "Password is required." })
  .min(PASSWORD_MIN_LENGTH, `Use at least ${PASSWORD_MIN_LENGTH} characters.`)
  .max(PASSWORD_MAX_LENGTH, `Use at most ${PASSWORD_MAX_LENGTH} characters.`);

// Length is capped before any Argon2 work happens.
const existingPasswordSchema = z
  .string({ error: "Password is required." })
  .min(1, "Password is required.")
  .max(PASSWORD_MAX_LENGTH, "Password is too long.");

// Shape-checked only; validity is decided by the hashed lookup.
export const tokenSchema = z.string({ error: "Token is required." }).min(1, "Token is required.").max(256);

export const nameSchema = z.string({ error: "Name is required." }).trim().min(1, "Name is required.").max(100);

export const loginSchema = z.strictObject({ email: emailSchema, password: existingPasswordSchema });

export const changePasswordSchema = z.strictObject({
  currentPassword: existingPasswordSchema,
  newPassword: newPasswordSchema,
});

export const forgotPasswordSchema = z.strictObject({ email: emailSchema });

export const resetPasswordSchema = z.strictObject({ token: tokenSchema, newPassword: newPasswordSchema });

export const updateProfileSchema = z.strictObject({ name: nameSchema });

export const invitationTokenSchema = z.strictObject({ token: tokenSchema });

export const acceptInvitationSchema = z.strictObject({
  token: tokenSchema,
  name: nameSchema,
  newPassword: newPasswordSchema,
});

export const sessionIdParamsSchema = z.object({ sessionId: z.uuid() });
