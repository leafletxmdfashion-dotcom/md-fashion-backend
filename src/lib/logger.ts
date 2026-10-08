import { pino } from "pino";

import { env } from "../config/env";

// Secrets must never reach log sinks. Request bodies are not logged at all;
// these paths cover headers and any object that is logged explicitly.
export const REDACT_PATHS = [
  "req.headers.cookie",
  "req.headers.authorization",
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
  "*.password",
  "*.currentPassword",
  "*.newPassword",
  "*.passwordHash",
  "*.token",
  "*.tokenHash",
  "*.csrfToken",
];

export const logger = pino({
  level: env.isTest ? "silent" : env.LOG_LEVEL,
  redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
  base: { service: "garment-api" },
});
