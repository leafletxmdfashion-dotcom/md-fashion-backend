import argon2 from "argon2";

import { AppError, ErrorCode } from "../../lib/errors";
import { generateToken } from "../../lib/crypto";
import { logger } from "../../lib/logger";

export const PASSWORD_MIN_LENGTH = 12;
// Long passphrases are welcome; the cap bounds Argon2 work per request.
export const PASSWORD_MAX_LENGTH = 128;

// OWASP 2024 Argon2id baseline: 19 MiB memory, 2 iterations, 1 lane.
const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

// Frequently breached passwords that satisfy the length rule. Not exhaustive;
// a breached-password API (k-anonymity) is the upgrade path.
const COMMON_PASSWORDS = new Set([
  "123456789012",
  "1234567890123",
  "12345678901234",
  "123456123456",
  "111111111111",
  "000000000000",
  "abcdefghijkl",
  "abc123abc123",
  "qwertyuiopas",
  "qwertyuiop12",
  "qwerty123456",
  "qwertyqwerty",
  "1q2w3e4r5t6y",
  "1qaz2wsx3edc",
  "asdfghjkl123",
  "zxcvbnm12345",
  "password1234",
  "password12345",
  "password123!",
  "passwordpassword",
  "password@123",
  "p@ssw0rd1234",
  "iloveyou1234",
  "welcome12345",
  "welcome@1234",
  "letmein12345",
  "administrator",
  "admin1234567",
  "adminadmin123",
  "changeme1234",
  "trustno11234",
  "football1234",
  "baseball1234",
  "sunshine1234",
  "princess1234",
  "monkey123456",
  "dragon123456",
  "starwars1234",
  "superman1234",
  "michael12345",
  "computer1234",
  "whatever1234",
  "garment12345",
  "garments1234",
]);

// NFKC so visually identical passphrases typed on different keyboards/OSes hash the same.
function normalize(password: string): string {
  return password.normalize("NFKC");
}

export function assertPasswordPolicy(password: string, context: { email?: string; name?: string } = {}): void {
  const candidate = normalize(password);
  const lowered = candidate.toLowerCase();
  const reasons: string[] = [];

  if (candidate.length < PASSWORD_MIN_LENGTH || candidate.length > PASSWORD_MAX_LENGTH) {
    reasons.push(`Use between ${PASSWORD_MIN_LENGTH} and ${PASSWORD_MAX_LENGTH} characters.`);
  }
  if (COMMON_PASSWORDS.has(lowered) || /^(.)\1+$/.test(candidate)) {
    reasons.push("This password is too common. Choose something less predictable.");
  }
  const email = context.email?.toLowerCase();
  const localPart = email?.split("@")[0];
  if (email && (lowered === email || (localPart && localPart.length >= 4 && lowered === localPart))) {
    reasons.push("Password must not match your email address.");
  }
  if (context.name && lowered === context.name.trim().toLowerCase()) {
    reasons.push("Password must not match your name.");
  }

  if (reasons.length > 0) {
    throw new AppError(400, ErrorCode.PASSWORD_TOO_WEAK, "Password does not meet requirements.", {
      newPassword: reasons,
    });
  }
}

export function hashPassword(password: string): Promise<string> {
  return argon2.hash(normalize(password), ARGON2_OPTIONS);
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, normalize(password));
  } catch (error) {
    // A malformed stored hash is a data problem, never a successful login.
    logger.error({ err: error }, "password hash verification failed");
    return false;
  }
}

export function passwordNeedsRehash(hash: string): boolean {
  return argon2.needsRehash(hash, ARGON2_OPTIONS);
}

// Verifying against a throwaway hash keeps "unknown account" responses as slow as
// "wrong password" ones, removing a timing oracle for user enumeration.
let dummyHash: Promise<string> | undefined;

export async function verifyDummyPassword(password: string): Promise<void> {
  dummyHash ??= hashPassword(generateToken());
  await verifyPassword(await dummyHash, password);
}
