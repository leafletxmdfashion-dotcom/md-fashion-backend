import { z } from "zod";

import { normalizeEmail, normalizePhone } from "../../lib/request";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "./password";

// Strict objects reject unknown keys, so clients cannot smuggle fields (mass assignment).

export const emailSchema = z
  .string({ error: "Email is required." })
  .trim()
  .min(1, "Email is required.")
  .max(254, "Email is too long.")
  .transform(normalizeEmail)
  .pipe(z.email("Enter a valid email address."));

export const phoneSchema = z
  .string({ error: "Phone is required." })
  .trim()
  .min(1, "Phone is required.")
  .max(32, "Phone is too long.")
  .transform(normalizePhone)
  .pipe(z.string().regex(/^\+?[0-9]{7,15}$/, "Enter a valid phone number."));

// Email or phone, as typed on the sign-in form. Shape-checked only; the lookup decides.
const loginIdSchema = z
  .string({ error: "Email or phone is required." })
  .trim()
  .min(1, "Email or phone is required.")
  .max(254, "Email or phone is too long.");

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

// `identifier` is an email or a phone number; `email` is the older name for the same field.
export const loginSchema = z
  .strictObject({
    identifier: loginIdSchema.optional(),
    email: loginIdSchema.optional(),
    password: existingPasswordSchema,
  })
  .refine((input) => input.identifier !== undefined || input.email !== undefined, {
    path: ["identifier"],
    message: "Email or phone is required.",
  })
  .transform(({ identifier, email, password }) => ({ login: (identifier ?? email)!, password }));

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
