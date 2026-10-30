import { Router, type Request, type RequestHandler } from "express";
import { z } from "zod";

import { isUniqueViolation, prisma, transaction } from "../../db/prisma";
import { AppError, ErrorCode, errors } from "../../lib/errors";
import { actorOf, clientMeta } from "../../lib/request";
import { recordAudit } from "../audit/audit.service";
import { requireAuth } from "../auth/auth.middleware";
import { requireAnyPermission, requirePermission } from "../permissions/permission.middleware";
import type { AuthContext, ClientMeta } from "../sessions/session.types";

// Jogadi: stitching teams of karigars. Membership is history (leaving sets left_at),
// so stitching issues keep the team they were given to, frozen in their own snapshot.

function fieldError(path: string, message: string): AppError {
  return new AppError(400, ErrorCode.VALIDATION_ERROR, message, { [path]: [message] });
}

/** Percent with 2 decimals → hundredths (33.33 → 3333), exact. */
const hundredths = (value: number) => Math.round(value * 100);

export const teamSchema = z
  .strictObject({
    name: z
      .string({ error: "Enter the team name." })
      .trim()
      .min(1, "Enter the team name.")
      .max(60, "Keep the name under 60 characters.")
      .transform((value) => value.replace(/\s+/g, " ")),
    active: z.boolean().default(true),
    notes: z
      .string()
      .trim()
      .max(500, "Keep notes under 500 characters.")
      .nullish()
      .transform((value) => value || null),
    members: z
      .array(
        z.strictObject({
          karigarId: z.uuid("Choose a karigar."),
          // Empty for every member: earnings split equally.
          sharePercent: z
            .number()
            .positive("Share must be above 0%.")
            .max(100, "Share cannot be above 100%.")
            .multipleOf(0.01, "Use at most 2 decimals.")
            .nullish()
            .transform((value) => value ?? null),
        }),
      )
      .min(1, "Add at least one member.")
      .max(50, "Use at most 50 members."),
  })
  .superRefine((team, ctx) => {
    const seen = new Set<string>();

    team.members.forEach((member, index) => {
      if (seen.has(member.karigarId)) {
        ctx.addIssue({ code: "custom", path: ["members", index, "karigarId"], message: "Listed twice." });
      }

      seen.add(member.karigarId);
    });

    const shares = team.members.filter((member) => member.sharePercent !== null);

    if (shares.length > 0 && shares.length < team.members.length) {
      ctx.addIssue({ code: "custom", path: ["members"], message: "Give every member a share, or none (equal split)." });
    } else if (
      shares.length > 0 &&
      shares.reduce((sum, member) => sum + hundredths(member.sharePercent!), 0) !== 10_000
    ) {
      ctx.addIssue({ code: "custom", path: ["members"], message: "Shares must add up to exactly 100%." });
    }
  });

export type TeamInput = z.infer<typeof teamSchema>;

const MEMBER_SELECT = {
  where: { leftAt: null },
  orderBy: { joinedAt: "asc" },
  select: {
    id: true,
    sharePercent: true,
    joinedAt: true,
    karigar: { select: { id: true, name: true, category: true, active: true } },
  },
} as const;

async function teamDto(id: string) {
  const [team, [held]] = await Promise.all([
    prisma.jogadiTeam.findUnique({ where: { id }, include: { members: MEMBER_SELECT } }),
    prisma.$queryRaw<{ pieces: number }[]>`
      SELECT COALESCE(sum(l.quantity - l.received), 0)::int AS pieces
      FROM stitching_issue_lines l JOIN stitching_issues i ON i.id = l.issue_id
      WHERE i.team_id = ${id}::uuid AND i.status = 'POSTED'`,
  ]);

  if (!team) throw errors.notFound("Jogadi team");

  return toDto(team, held!.pieces);
}

type TeamRecord = NonNullable<Awaited<ReturnType<typeof findTeams>>>[number];

function findTeams(activeOnly: boolean) {
  return prisma.jogadiTeam.findMany({
    where: activeOnly ? { active: true } : {},
    orderBy: [{ active: "desc" }, { name: "asc" }],
    include: { members: MEMBER_SELECT },
  });
}

function toDto(team: TeamRecord, piecesHeld: number) {
  return {
    id: team.id,
    code: team.code ?? "",
    name: team.name,
    active: team.active,
    notes: team.notes,
    members: team.members.map((member) => ({
      karigarId: member.karigar.id,
      name: member.karigar.name,
      category: member.karigar.category,
      active: member.karigar.active,
      sharePercent: member.sharePercent === null ? null : member.sharePercent.toNumber(),
      joinedAt: member.joinedAt,
    })),
    /** Pieces issued to the team and not yet received back. */
    piecesHeld,
  };
}

export type TeamDto = ReturnType<typeof toDto>;

const duplicateName = () =>
  new AppError(409, ErrorCode.CONFLICT, "Another team already has this name.", {
    name: ["Another team already has this name."],
  });

/**
 * Refuses a name another team has (any case) before inserting, so a refused
 * duplicate does not use up a JG code. The unique index still settles races.
 */
async function assertNameFree(tx: Pick<typeof prisma, "$queryRaw">, name: string, exceptId: string | null) {
  const [taken] = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM jogadi_teams
    WHERE lower(btrim(name)) = lower(btrim(${name})) AND id IS DISTINCT FROM ${exceptId}::uuid`;

  if (taken) throw duplicateName();
}

/** New members must be active karigars; current ones may stay even if since deactivated. */
async function assertMembers(tx: Pick<typeof prisma, "karigar">, input: TeamInput, current: Set<string>) {
  const karigars = await tx.karigar.findMany({
    where: { id: { in: input.members.map((member) => member.karigarId) } },
    select: { id: true, active: true },
  });

  const byId = new Map(karigars.map((karigar) => [karigar.id, karigar]));

  input.members.forEach((member, index) => {
    const karigar = byId.get(member.karigarId);

    if (!karigar || (!karigar.active && !current.has(member.karigarId))) {
      throw fieldError(`members.${index}.karigarId`, "Choose an active karigar.");
    }
  });
}

export const jogadiService = {
  // ponytail: teams are a small master list, returned whole; page it if a factory ever has hundreds.
  async list(activeOnly: boolean): Promise<TeamDto[]> {
    const [teams, held] = await Promise.all([
      findTeams(activeOnly),
      prisma.$queryRaw<{ team_id: string; pieces: number }[]>`
        SELECT i.team_id, sum(l.quantity - l.received)::int AS pieces
        FROM stitching_issue_lines l JOIN stitching_issues i ON i.id = l.issue_id
        WHERE i.status = 'POSTED' GROUP BY i.team_id`,
    ]);

    const heldBy = new Map(held.map((row) => [row.team_id, row.pieces]));

    return teams.map((team) => toDto(team, heldBy.get(team.id) ?? 0));
  },

  get: teamDto,

  async create(actor: AuthContext, input: TeamInput, meta: ClientMeta): Promise<TeamDto> {
    try {
      const id = await transaction(async (tx) => {
        await assertNameFree(tx, input.name, null);
        await assertMembers(tx, input, new Set());

        const team = await tx.jogadiTeam.create({
          data: {
            name: input.name,
            active: input.active,
            notes: input.notes,
            createdById: actor.user.id,
            members: {
              createMany: {
                data: input.members.map((member) => ({
                  karigarId: member.karigarId,
                  sharePercent: member.sharePercent,
                })),
              },
            },
          },
          select: { id: true },
        });

        await recordAudit(tx, {
          type: "JOGADI_CREATED",
          actorUserId: actor.user.id,
          sessionId: actor.sessionId,
          meta,
          metadata: { teamId: team.id, name: input.name, members: input.members.length },
        });

        return team.id;
      });

      return await teamDto(id);
    } catch (error) {
      throw isUniqueViolation(error) ? duplicateName() : error;
    }
  },

  /** Renames, (de)activates and changes members. Leavers keep their history; issued work keeps its snapshot. */
  async update(actor: AuthContext, id: string, input: TeamInput, meta: ClientMeta): Promise<TeamDto> {
    try {
      await transaction(async (tx) => {
        const [locked] = await tx.$queryRaw<
          { id: string }[]
        >`SELECT id FROM jogadi_teams WHERE id = ${id}::uuid FOR UPDATE`;

        if (!locked) throw errors.notFound("Jogadi team");

        const current = await tx.jogadiMember.findMany({ where: { teamId: id, leftAt: null } });
        const currentIds = new Set(current.map((member) => member.karigarId));
        const next = new Map(input.members.map((member) => [member.karigarId, member]));

        await assertMembers(tx, input, currentIds);

        const leaving = current.filter((member) => !next.has(member.karigarId));
        const joining = input.members.filter((member) => !currentIds.has(member.karigarId));

        const reshared = current.filter((member) => {
          const share = next.get(member.karigarId)?.sharePercent;

          return share !== undefined && (member.sharePercent?.toNumber() ?? null) !== share;
        });

        if (leaving.length > 0) {
          await tx.jogadiMember.updateMany({
            where: { id: { in: leaving.map((member) => member.id) } },
            data: { leftAt: new Date() },
          });
        }

        if (joining.length > 0) {
          await tx.jogadiMember.createMany({
            data: joining.map((member) => ({
              teamId: id,
              karigarId: member.karigarId,
              sharePercent: member.sharePercent,
            })),
          });
        }

        for (const member of reshared) {
          await tx.jogadiMember.update({
            where: { id: member.id },
            data: { sharePercent: next.get(member.karigarId)!.sharePercent },
          });
        }

        await tx.jogadiTeam.update({
          where: { id },
          data: { name: input.name, active: input.active, notes: input.notes },
        });
        await recordAudit(tx, {
          type: "JOGADI_UPDATED",
          actorUserId: actor.user.id,
          sessionId: actor.sessionId,
          meta,
          metadata: { teamId: id, joined: joining.length, left: leaving.length, active: input.active },
        });
      });

      return await teamDto(id);
    } catch (error) {
      throw isUniqueViolation(error) ? duplicateName() : error;
    }
  },
};

const idOf = (req: Request) => z.object({ id: z.uuid() }).parse(req.params).id;

export function jogadiRoutes(): Router {
  const router = Router();

  router.use(requireAuth);

  const manage = requirePermission("karigar.manage");

  // The team list feeds both the Jogadi screen and the stitching issue form.
  router.get("/", requireAnyPermission("karigar.view", "stitching.view"), (async (req, res) => {
    const activeOnly = z.object({ active: z.enum(["true", "false"]).optional() }).parse(req.query).active === "true";

    res.json({ success: true, data: { teams: await jogadiService.list(activeOnly) } });
  }) satisfies RequestHandler);

  router.get("/:id", requireAnyPermission("karigar.view", "stitching.view"), (async (req, res) => {
    res.json({ success: true, data: { team: await jogadiService.get(idOf(req)) } });
  }) satisfies RequestHandler);

  router.post("/", manage, (async (req, res) => {
    const team = await jogadiService.create(actorOf(req), teamSchema.parse(req.body), clientMeta(req));

    res.status(201).json({ success: true, data: { team } });
  }) satisfies RequestHandler);

  router.put("/:id", manage, (async (req, res) => {
    const team = await jogadiService.update(actorOf(req), idOf(req), teamSchema.parse(req.body), clientMeta(req));

    res.json({ success: true, data: { team } });
  }) satisfies RequestHandler);

  return router;
}
