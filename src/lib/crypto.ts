import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// 32 bytes = 256 bits of CSPRNG entropy, base64url so it is cookie/URL safe.
export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

// Tokens are high-entropy, so a fast unsalted SHA-256 is sufficient: the stored
// digest cannot be reversed into a usable token, and lookups stay indexable.
export type TokenHash = Uint8Array<ArrayBuffer>;

export function hashToken(token: string): TokenHash {
  return createHash("sha256").update(token, "utf8").digest();
}

export function hmac(secret: string, value: string): string {
  return createHmac("sha256", secret).update(value, "utf8").digest("base64url");
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}
