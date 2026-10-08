import type { CookieOptions, Response } from "express";

import { env, type Env } from "../../config/env";

type CookieConfig = Pick<Env, "isProduction" | "sessionAbsoluteTimeoutMs">;

// Production uses the __Host- prefix: the browser then enforces Secure, Path=/ and
// no Domain attribute, so sibling subdomains can neither read nor overwrite it.
// Local development runs over plain http, where __Host-/Secure cookies are unreliable.
export function cookieNames(config: Pick<Env, "isProduction"> = env) {
  const prefix = config.isProduction ? "__Host-" : "";
  return { session: `${prefix}gm_session`, csrf: `${prefix}gm_csrf` };
}

function baseOptions(config: CookieConfig): CookieOptions {
  return {
    httpOnly: true,
    secure: config.isProduction,
    // Lax keeps the session on top-level navigations from links (email, chat) while
    // blocking cross-site subresource/POST sends. CSRF tokens cover the rest.
    sameSite: "lax",
    path: "/",
  };
}

export function sessionCookieOptions(config: CookieConfig = env): CookieOptions {
  return { ...baseOptions(config), maxAge: config.sessionAbsoluteTimeoutMs };
}

// Browser-session lifetime: the anonymous CSRF nonce only protects pre-login forms.
export function csrfCookieOptions(config: CookieConfig = env): CookieOptions {
  return baseOptions(config);
}

export function setSessionCookie(res: Response, token: string): void {
  res.cookie(cookieNames().session, token, sessionCookieOptions());
}

// clearCookie must repeat the attributes used when setting, minus maxAge/expires.
export function clearSessionCookie(res: Response): void {
  res.clearCookie(cookieNames().session, baseOptions(env));
}

export function setCsrfCookie(res: Response, nonce: string): void {
  res.cookie(cookieNames().csrf, nonce, csrfCookieOptions());
}

export function readCookie(cookies: unknown, name: string): string | undefined {
  if (typeof cookies !== "object" || cookies === null) return undefined;
  const value: unknown = (cookies as Record<string, unknown>)[name];
  return typeof value === "string" ? value : undefined;
}
