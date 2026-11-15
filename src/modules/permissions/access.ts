import { Router, type Request, type RequestHandler } from "express";
import { z } from "zod";

import { prisma, transaction } from "../../db/prisma";
import { AppError, ErrorCode, errors } from "../../lib/errors";
import { karigarCode } from "../../lib/labels";
import { actorOf, clientMeta } from "../../lib/request";
import { recordAudit } from "../audit/audit.service";
import { requireAuth } from "../auth/auth.middleware";
import { sessionService } from "../sessions/session.service";
import type { AuthContext, ClientMeta } from "../sessions/session.types";
import { requirePermission } from "./permission.middleware";
import { isOwner } from "./permission.service";
import { isPermission, PERMISSIONS, type Permission } from "./permission.types";

// Per-person access: on top of their role, one person may be given a right (ALLOW) or have
// one of the role's rights taken away (DENY). The session query applies them: effective =
// (role + ALLOW) - DENY; owners hold everything regardless. Only holders of roles.manage
// may change them, for people ranked below themselves, and only rights they hold.

export type Effect = "ALLOW" | "DENY";

const overridesSchema = z.strictObject({
  overrides: z
    .array(
      z.strictObject({
        permission: z.string().refine(isPermission, "Unknown permission."),
        effect: z.enum(["ALLOW", "DENY"]),
      }),
    )
    .max(PERMISSIONS.length),
  reason: z
    .string({ error: "Say why access is changing." })
    .trim()
    .min(3, "Say why access is changing (at least 3 characters).")
    .max(500, "Keep the reason under 500 characters."),
});

interface Target {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  status: string;
  last_login_at: Date | null;
  role_id: string;
  role_key: string;
  role_name: string;
  role_rank: number;
  karigar_id: string | null;
  karigar_number: number | null;
  karigar_category: string | null;
}

const TARGET_SQL = `
  SELECT u.id, u.name, u.email, u.phone, u.status::text AS status, u.last_login_at, u.role_id,
         r.key AS role_key, r.name AS role_name, r.rank AS role_rank,
         k.id AS karigar_id, k.number AS karigar_number, k.category AS karigar_category
  FROM users u JOIN roles r ON r.id = u.role_id LEFT JOIN karigars k ON k.user_id = u.id`;

/** The caller may change this person's access: not themselves, not an owner, ranked below them (owners: anyone). */
function canEdit(actor: AuthContext, target: Pick<Target, "id" | "role_key" | "role_rank">): boolean {
  if (!actor.user.permissions.has("roles.manage") || target.id === actor.user.id) return false;

  if (isOwner({ key: target.role_key })) return false;

  return isOwner(actor.user.role) || target.role_rank < actor.user.role.rank;
}

function person(actor: AuthContext, row: Target) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    status: row.status,
    lastLoginAt: row.last_login_at,
    role: { key: row.role_key, name: row.role_name, rank: row.role_rank },
    karigar:
      row.karigar_id && row.karigar_number !== null
        ? { id: row.karigar_id, code: karigarCode(row.karigar_number), category: row.karigar_category }
        : null,
    editable: canEdit(actor, row),
  };
}

async function findTarget(id: string): Promise<Target> {
  const [row] = await prisma.$queryRawUnsafe<Target[]>(`${TARGET_SQL} WHERE u.id = $1::uuid`, id);

  if (!row) throw errors.notFound("User");

  return row;
}

async function detail(actor: AuthContext, id: string) {
  const target = await findTarget(id);
  const [rolePermissions, overrides] = await Promise.all([
    prisma.rolePermission.findMany({ where: { roleId: target.role_id }, select: { permission: true } }),
    prisma.userPermissionOverride.findMany({
      where: { userId: id },
      orderBy: { permission: "asc" },
      include: { createdBy: { select: { name: true } } },
    }),
  ]);

  const owner = isOwner({ key: target.role_key });
  const fromRole = owner ? [...PERMISSIONS] : rolePermissions.map((row) => row.permission).filter(isPermission);
  const allowed = new Set(overrides.filter((row) => row.effect === "ALLOW").map((row) => row.permission));
  const denied = new Set(overrides.filter((row) => row.effect === "DENY").map((row) => row.permission));
  const effective = owner
    ? fromRole
    : PERMISSIONS.filter(
        (permission) => (fromRole.includes(permission) || allowed.has(permission)) && !denied.has(permission),
      );

  return {
    person: person(actor, target),
    /** Owners hold every right; overrides do not apply to them. */
    owner,
    rolePermissions: fromRole,
    overrides: overrides
      .filter((row) => isPermission(row.permission))
      .map((row) => ({
        permission: row.permission as Permission,
        effect: row.effect as Effect,
        reason: row.reason,
        createdAt: row.createdAt,
        createdBy: row.createdBy?.name ?? null,
      })),
    effective,
  };
}

export const accessService = {
  /** Everyone with a login, with their role and how many rights were given or taken on top of it. */
  // ponytail: logins are tens, returned whole and searched on the client.
  async list(actor: AuthContext) {
    const [rows, counts] = await Promise.all([
      prisma.$queryRawUnsafe<Target[]>(`${TARGET_SQL} ORDER BY r.rank DESC, u.name`),
      prisma.$queryRaw<{ user_id: string; allowed: number; denied: number }[]>`
        SELECT user_id, count(*) FILTER (WHERE effect = 'ALLOW')::int AS allowed,
               count(*) FILTER (WHERE effect = 'DENY')::int AS denied
        FROM user_permission_overrides GROUP BY user_id`,
    ]);
    const countOf = new Map(counts.map((row) => [row.user_id, row]));

    return rows.map((row) => ({
      ...person(actor, row),
      allowed: countOf.get(row.id)?.allowed ?? 0,
      denied: countOf.get(row.id)?.denied ?? 0,
    }));
  },

  get: detail,

  /**
   * Replaces a person's overrides. No-ops are dropped (allowing what the role gives, denying
   * what it lacks). Every right added, removed or flipped must be one the caller holds.
   */
  async replace(
    actor: AuthContext,
    id: string,
    input: { overrides: { permission: string; effect: Effect }[]; reason: string },
    meta: ClientMeta,
  ) {
    await transaction(async (tx) => {
      const [target] = await tx.$queryRawUnsafe<Target[]>(`${TARGET_SQL} WHERE u.id = $1::uuid FOR UPDATE OF u`, id);

      if (!target) throw errors.notFound("User");

      if (!canEdit(actor, target)) {
        throw new AppError(
          403,
          ErrorCode.AUTH_FORBIDDEN,
          target.id === actor.user.id
            ? "You cannot change your own access."
            : isOwner({ key: target.role_key })
              ? "Owners always hold every permission."
              : "You can only change access for people ranked below you.",
        );
      }

      const fromRole = new Set(
        (await tx.rolePermission.findMany({ where: { roleId: target.role_id }, select: { permission: true } })).map(
          (row) => row.permission,
        ),
      );
      const wanted = new Map<string, Effect>();

      for (const row of input.overrides) {
        if (wanted.has(row.permission)) {
          throw new AppError(400, ErrorCode.VALIDATION_ERROR, "A permission is listed twice.", {
            overrides: [`${row.permission} is listed twice.`],
          });
        }

        // Only real changes from the role are kept.
        if ((row.effect === "ALLOW") !== fromRole.has(row.permission)) wanted.set(row.permission, row.effect);
      }

      const current = new Map(
        (await tx.userPermissionOverride.findMany({ where: { userId: id } })).map((row) => [
          row.permission,
          row.effect,
        ]),
      );
      const changed = [...new Set([...current.keys(), ...wanted.keys()])].filter(
        (permission) => current.get(permission) !== wanted.get(permission),
      );

      if (changed.length === 0) return;

      const missing = changed.filter((permission) => !actor.user.permissions.has(permission as Permission));

      if (missing.length > 0) {
        throw new AppError(
          403,
          ErrorCode.AUTH_FORBIDDEN,
          "You can only give or take away permissions you hold yourself.",
          { overrides: [`Not yours to change: ${missing.join(", ")}.`] },
        );
      }

      await tx.userPermissionOverride.deleteMany({ where: { userId: id, permission: { in: changed } } });

      const added = changed.filter((permission) => wanted.has(permission));

      if (added.length > 0) {
        await tx.userPermissionOverride.createMany({
          data: added.map((permission) => ({
            userId: id,
            permission,
            effect: wanted.get(permission)!,
            reason: input.reason,
            createdById: actor.user.id,
          })),
        });
      }

      await recordAudit(tx, {
        type: "PERMISSION_OVERRIDE_CHANGED",
        actorUserId: actor.user.id,
        targetUserId: id,
        sessionId: actor.sessionId,
        meta,
        metadata: {
          role: target.role_key,
          allowed: changed.filter((permission) => wanted.get(permission) === "ALLOW"),
          denied: changed.filter((permission) => wanted.get(permission) === "DENY"),
          reset: changed.filter((permission) => !wanted.has(permission)),
          reason: input.reason,
        },
      });
    });

    // Who may do what changed: cached sessions must re-read their rights.
    sessionService.forgetCached();

    return detail(actor, id);
  },
};

const idOf = (req: Request) => z.object({ userId: z.uuid() }).parse(req.params).userId;

export function accessRoutes(): Router {
  const router = Router();

  router.use(requireAuth, requirePermission("roles.manage"));

  router.get("/", (async (req, res) => {
    res.json({ success: true, data: { people: await accessService.list(actorOf(req)) } });
  }) satisfies RequestHandler);

  router.get("/:userId", (async (req, res) => {
    res.json({ success: true, data: await accessService.get(actorOf(req), idOf(req)) });
  }) satisfies RequestHandler);

  router.put("/:userId", (async (req, res) => {
    const input = overridesSchema.parse(req.body) as {
      overrides: { permission: string; effect: Effect }[];
      reason: string;
    };

    res.json({ success: true, data: await accessService.replace(actorOf(req), idOf(req), input, clientMeta(req)) });
  }) satisfies RequestHandler);

  return router;
}
