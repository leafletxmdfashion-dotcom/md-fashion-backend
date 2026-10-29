import { env } from "../../config/env";
import type { Db } from "../../db/prisma";
import { generateToken, hashToken } from "../../lib/crypto";
import { isPermission, OWNER_ROLE, PERMISSIONS, type Permission } from "../permissions/permission.types";
import { sessionRepository } from "./session.repository";
import type { AuthContext, ClientMeta, SessionRevokeReason, SessionSummary } from "./session.types";

// last_seen_at is only rewritten when older than this, so authenticated reads do not
// cost a write each. Idle-timeout precision is therefore ±1 minute.
const TOUCH_INTERVAL_MS = 60_000;

// Opaque tokens are base64url of 32 bytes (43 chars). Anything else is rejected before hashing.
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

// Every authenticated request resolves its session, and against a remote database
// that lookup is a full round trip. A verified session is reused for a few seconds.
// Revoking sessions or changing a role or user in this process clears the cache, so
// those take effect at once here; another API instance may still honour the old
// state for up to AUTH_CACHE_MS. The key is the token's hash, never the token.
// Off in tests, which edit users and roles straight in the database.
const AUTH_CACHE_MS = env.isTest ? 0 : 10_000;
const AUTH_CACHE_MAX = 5_000;
const authCache = new Map<string, { auth: AuthContext; until: number }>();

export interface IssuedSession {
  sessionId: string;
  token: string;
  expiresAt: Date;
}

export const sessionService = {
  async create(db: Db, userId: string, meta: ClientMeta): Promise<IssuedSession> {
    const token = generateToken();
    const expiresAt = new Date(Date.now() + env.sessionAbsoluteTimeoutMs);
    const sessionId = await sessionRepository.create(db, { userId, tokenHash: hashToken(token), expiresAt, meta });
    return { sessionId, token, expiresAt };
  },

  async authenticate(token: string | undefined): Promise<AuthContext | null> {
    if (!token || !TOKEN_PATTERN.test(token)) return null;

    const tokenHash = hashToken(token);
    const key = Buffer.from(tokenHash).toString("base64");
    const cached = authCache.get(key);
    const now = Date.now();
    if (cached && cached.until > now && cached.auth.expiresAt.getTime() > now) return cached.auth;

    const row = await sessionRepository.findValidByTokenHash(tokenHash, env.sessionIdleTimeoutMs);
    if (!row) {
      authCache.delete(key);
      return null;
    }

    if (Date.now() - row.last_seen_at.getTime() > TOUCH_INTERVAL_MS) {
      await sessionRepository.touch(row.session_id);
    }

    // Owners hold every permission, including ones added to the catalog later.
    const permissions = new Set<Permission>(
      row.role_key === OWNER_ROLE ? PERMISSIONS : row.permissions.filter(isPermission),
    );
    const auth: AuthContext = {
      sessionId: row.session_id,
      expiresAt: row.expires_at,
      user: {
        id: row.user_id,
        email: row.email,
        name: row.name,
        status: row.status,
        role: { key: row.role_key, name: row.role_name, rank: row.role_rank },
        permissions,
      },
    };
    // ponytail: clearing the whole map when full is crude; an LRU only if thousands of sessions are live.
    if (authCache.size >= AUTH_CACHE_MAX) authCache.clear();
    authCache.set(key, { auth, until: now + AUTH_CACHE_MS });
    return auth;
  },

  /** Drops every cached session, after anything that changes who may do what. */
  forgetCached(): void {
    authCache.clear();
  },

  revoke(db: Db, sessionId: string, reason: SessionRevokeReason): Promise<boolean> {
    authCache.clear();
    return sessionRepository.revokeById(db, sessionId, reason);
  },

  revokeOwned(db: Db, sessionId: string, userId: string, reason: SessionRevokeReason): Promise<boolean> {
    authCache.clear();
    return sessionRepository.revokeOwnedById(db, sessionId, userId, reason);
  },

  // Used at login to retire whatever session cookie the browser presented, even an
  // expired one, so a pre-login token can never be carried into the new session.
  async revokePresentedToken(db: Db, token: string | undefined, reason: SessionRevokeReason): Promise<void> {
    if (token && TOKEN_PATTERN.test(token)) {
      authCache.clear();
      await sessionRepository.revokeByTokenHash(db, hashToken(token), reason);
    }
  },

  revokeAllForUser(db: Db, userId: string, reason: SessionRevokeReason): Promise<number> {
    authCache.clear();
    return sessionRepository.revokeAllForUser(db, userId, reason);
  },

  listActive(userId: string): Promise<SessionSummary[]> {
    return sessionRepository.listActiveForUser(userId, env.sessionIdleTimeoutMs);
  },
};
