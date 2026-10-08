import "dotenv/config";

import { z } from "zod";

const PLACEHOLDER_SECRET = "replace-with-at-least-32-random-characters";

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().positive().default(5000),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),

    // The single browser origin allowed to call this API with credentials.
    CLIENT_URL: z.url(),
    DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

    // HMAC key for CSRF tokens. Rotating it invalidates outstanding CSRF tokens only.
    CSRF_SECRET: z.string().min(32, "CSRF_SECRET must be at least 32 characters"),

    // Express "trust proxy": "false", a hop count, or a comma-separated list of
    // trusted addresses/subnets ("loopback", "10.0.0.0/8", ...). "true" is rejected
    // because it trusts any client-supplied X-Forwarded-For.
    TRUST_PROXY: z.string().default("false"),

    SESSION_IDLE_TIMEOUT_MINUTES: z.coerce.number().int().min(5).max(1440).default(120),
    SESSION_ABSOLUTE_TIMEOUT_HOURS: z.coerce.number().int().min(1).max(720).default(12),

    MAIL_TRANSPORT: z.enum(["outbox", "resend"]).default("outbox"),
    MAIL_FROM: z.string().min(3).default("Garment Manager <no-reply@localhost>"),
    MAIL_OUTBOX_DIR: z.string().default(".outbox"),
    RESEND_API_KEY: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    if (env.TRUST_PROXY.trim().toLowerCase() === "true") {
      ctx.addIssue({
        code: "custom",
        path: ["TRUST_PROXY"],
        message: "TRUST_PROXY=true trusts every hop; use a hop count or explicit subnets",
      });
    }
    if (env.MAIL_TRANSPORT === "resend" && !env.RESEND_API_KEY) {
      ctx.addIssue({ code: "custom", path: ["RESEND_API_KEY"], message: "required when MAIL_TRANSPORT=resend" });
    }
    if (env.NODE_ENV !== "production") return;

    if (!env.CLIENT_URL.startsWith("https://")) {
      ctx.addIssue({ code: "custom", path: ["CLIENT_URL"], message: "must use https in production" });
    }
    if (env.CSRF_SECRET === PLACEHOLDER_SECRET) {
      ctx.addIssue({ code: "custom", path: ["CSRF_SECRET"], message: "placeholder secret used in production" });
    }
    if (env.MAIL_TRANSPORT === "outbox") {
      ctx.addIssue({ code: "custom", path: ["MAIL_TRANSPORT"], message: "outbox transport is development-only" });
    }
  });

function parseTrustProxy(value: string): boolean | number | string[] {
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.toLowerCase() === "false") return false;
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  return trimmed
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function loadEnv() {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => `  ${issue.path.join(".")}: ${issue.message}`).join("\n");
    // Fail fast: the process must not start with an unsafe or incomplete configuration.
    throw new Error(`Invalid environment configuration:\n${details}`);
  }

  const env = parsed.data;
  const isProduction = env.NODE_ENV === "production";

  return {
    ...env,
    isProduction,
    isTest: env.NODE_ENV === "test",
    clientOrigin: new URL(env.CLIENT_URL).origin,
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    sessionIdleTimeoutMs: env.SESSION_IDLE_TIMEOUT_MINUTES * 60_000,
    sessionAbsoluteTimeoutMs: env.SESSION_ABSOLUTE_TIMEOUT_HOURS * 3_600_000,
  };
}

export type Env = ReturnType<typeof loadEnv>;

export const env: Env = loadEnv();
