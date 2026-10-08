import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError } from "zod";

// Stable, machine-readable error codes. Clients branch on these, never on messages.
export const ErrorCode = {
  VALIDATION_ERROR: "VALIDATION_ERROR",
  BAD_REQUEST: "BAD_REQUEST",
  PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",
  AUTH_INVALID_CREDENTIALS: "AUTH_INVALID_CREDENTIALS",
  AUTH_UNAUTHENTICATED: "AUTH_UNAUTHENTICATED",
  AUTH_FORBIDDEN: "AUTH_FORBIDDEN",
  AUTH_CURRENT_PASSWORD_INCORRECT: "AUTH_CURRENT_PASSWORD_INCORRECT",
  PASSWORD_TOO_WEAK: "PASSWORD_TOO_WEAK",
  PASSWORD_REUSED: "PASSWORD_REUSED",
  TOKEN_INVALID: "TOKEN_INVALID",
  CSRF_INVALID: "CSRF_INVALID",
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",
  LAST_OWNER: "LAST_OWNER",
  RATE_LIMITED: "RATE_LIMITED",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, string[]>,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const errors = {
  invalidCredentials: () => new AppError(401, ErrorCode.AUTH_INVALID_CREDENTIALS, "Invalid email or password."),
  unauthenticated: () => new AppError(401, ErrorCode.AUTH_UNAUTHENTICATED, "Authentication required."),
  forbidden: () => new AppError(403, ErrorCode.AUTH_FORBIDDEN, "You do not have permission to perform this action."),
  csrf: () => new AppError(403, ErrorCode.CSRF_INVALID, "Invalid or missing CSRF token."),
  notFound: (what = "Resource") => new AppError(404, ErrorCode.NOT_FOUND, `${what} not found.`),
  conflict: (message: string) => new AppError(409, ErrorCode.CONFLICT, message),
  tokenInvalid: () => new AppError(400, ErrorCode.TOKEN_INVALID, "This link is invalid or has expired."),
  rateLimited: () => new AppError(429, ErrorCode.RATE_LIMITED, "Too many requests. Please try again later."),
};

export type ErrorBody = {
  success: false;
  error: { code: ErrorCode; message: string; details?: Record<string, string[]> };
};

function zodDetails(error: ZodError): Record<string, string[]> {
  const details: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "_";
    (details[key] ??= []).push(issue.message);
  }
  return details;
}

export const notFoundHandler: RequestHandler = (_req, _res, next) => {
  next(errors.notFound("Route"));
};

export const errorHandler: ErrorRequestHandler = (err: unknown, req, res, _next) => {
  let appError: AppError;

  if (err instanceof AppError) {
    appError = err;
  } else if (err instanceof ZodError) {
    appError = new AppError(400, ErrorCode.VALIDATION_ERROR, "Request validation failed.", zodDetails(err));
  } else if (isBodyParserError(err)) {
    appError =
      err.type === "entity.too.large"
        ? new AppError(413, ErrorCode.PAYLOAD_TOO_LARGE, "Request body too large.")
        : new AppError(400, ErrorCode.BAD_REQUEST, "Malformed request body.");
  } else {
    // Unknown errors (SQL, hashing, programming errors) are logged server-side only.
    req.log.error({ err }, "unhandled error");
    appError = new AppError(500, ErrorCode.INTERNAL_ERROR, "Something went wrong. Please try again.");
  }

  const body: ErrorBody = {
    success: false,
    error: {
      code: appError.code,
      message: appError.message,
      ...(appError.details ? { details: appError.details } : {}),
    },
  };
  res.status(appError.status).json(body);
};

function isBodyParserError(err: unknown): err is { type: string } {
  return typeof err === "object" && err !== null && "type" in err && typeof err.type === "string" && "status" in err;
}
