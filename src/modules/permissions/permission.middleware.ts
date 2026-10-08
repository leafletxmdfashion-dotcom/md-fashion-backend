import type { RequestHandler } from "express";

import { errors } from "../../lib/errors";
import { hasPermission } from "./permission.service";
import type { Permission } from "./permission.types";

// Both guards assume requireAuth ran first, but fail closed if it did not.

export function requirePermission(...permissions: Permission[]): RequestHandler {
  return (req, _res, next) => {
    const user = req.auth?.user;
    if (!user) {
      next(errors.unauthenticated());
      return;
    }
    next(permissions.every((permission) => hasPermission(user, permission)) ? undefined : errors.forbidden());
  };
}

export function requireRole(...roleKeys: string[]): RequestHandler {
  return (req, _res, next) => {
    const user = req.auth?.user;
    if (!user) {
      next(errors.unauthenticated());
      return;
    }
    next(roleKeys.includes(user.role.key) ? undefined : errors.forbidden());
  };
}
