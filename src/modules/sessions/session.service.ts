import { env } from "../../config/env";
import type { Queryable } from "../../db/pool";
import { generateToken, hashToken } from "../../lib/crypto";
import { isPermission, type Permission } from "../permissions/permission.types";
import { sessionRepository } from "./session.repository";
import type { AuthContext, ClientMeta, SessionRevokeReason, SessionSummary } from "./session.types";

// last_seen_at is only rewritten when older than this, so authenticated reads do not
// cost a write each. Idle-timeout precision is therefore ±1 minute.
const TOUCH_INTERVAL_MS = 60_000;

// Opaque tokens are base64url of 32 bytes (43 chars). Anything else is rejected before hashing.
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface IssuedSession {
  sessionId: string;
  token: string;
  expiresAt: Date;
}

export const sessionService = {
  async create(db: Queryable, userId: string, meta: ClientMeta): Promise<IssuedSession> {
    const token = generateToken();
    const expiresAt = new Date(Date.now() + env.sessionAbsoluteTimeoutMs);
    const sessionId = await sessionRepository.create(db, { userId, tokenHash: hashToken(token), expiresAt, meta });
    return { sessionId, token, expiresAt };
  },

  async authenticate(token: string | undefined): Promise<AuthContext | null> {
    if (!token || !TOKEN_PATTERN.test(token)) return null;

    const row = await sessionRepository.findValidByTokenHash(hashToken(token), env.sessionIdleTimeoutMs);
    if (!row) return null;

    if (Date.now() - row.last_seen_at.getTime() > TOUCH_INTERVAL_MS) {
      await sessionRepository.touch(row.session_id);
    }

    const permissions = new Set<Permission>(row.permissions.filter(isPermission));
    return {
      sessionId: row.session_id,
      user: {
        id: row.user_id,
        email: row.email,
        name: row.name,
        status: row.status,
        role: { key: row.role_key, name: row.role_name, rank: row.role_rank },
        permissions,
      },
    };
  },

  revoke(db: Queryable, sessionId: string, reason: SessionRevokeReason): Promise<boolean> {
    return sessionRepository.revokeById(db, sessionId, reason);
  },

  revokeOwned(db: Queryable, sessionId: string, userId: string, reason: SessionRevokeReason): Promise<boolean> {
    return sessionRepository.revokeOwnedById(db, sessionId, userId, reason);
  },

  // Used at login to retire whatever session cookie the browser presented, even an
  // expired one, so a pre-login token can never be carried into the new session.
  async revokePresentedToken(db: Queryable, token: string | undefined, reason: SessionRevokeReason): Promise<void> {
    if (token && TOKEN_PATTERN.test(token)) {
      await sessionRepository.revokeByTokenHash(db, hashToken(token), reason);
    }
  },

  revokeAllForUser(db: Queryable, userId: string, reason: SessionRevokeReason): Promise<number> {
    return sessionRepository.revokeAllForUser(db, userId, reason);
  },

  listActive(userId: string): Promise<SessionSummary[]> {
    return sessionRepository.listActiveForUser(userId, env.sessionIdleTimeoutMs);
  },
};
