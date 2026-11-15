import { Router, type Request, type RequestHandler } from "express";
import { z } from "zod";

import { isUniqueViolation, prisma, Prisma, transaction } from "../../db/prisma";
import { factoryToday } from "../../lib/business-date";
import { AppError, ErrorCode, errors } from "../../lib/errors";
import { karigarCode } from "../../lib/labels";
import { actorOf, clientMeta } from "../../lib/request";
import { recordAudit } from "../audit/audit.service";
import { requireAuth } from "../auth/auth.middleware";
import { requireAnyPermission, requirePermission } from "../permissions/permission.middleware";
import type { AuthContext, ClientMeta } from "../sessions/session.types";

// Teams of karigars: Jogadi (stitching) or Packing. Membership is history (leaving sets
// left_at), so work keeps the team it was given to, frozen in its own snapshot. Team
// earnings split equally; the kind is chosen once, when the team is made.

export const TEAM_KINDS = ["JOGADI", "PACKING"] as const;

export type TeamKind = (typeof TEAM_KINDS)[number];

function fieldError(path: string, message: string): AppError {
  return new AppError(400, ErrorCode.VALIDATION_ERROR, message, { [path]: [message] });
}

export const teamSchema = z
  .strictObject({
    /** Fixed after creation; an update must send the team's own kind or leave it out. */
    kind: z.enum(TEAM_KINDS, { error: "Choose Jogadi or Packing." }).optional(),
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
      .array(z.strictObject({ karigarId: z.uuid("Choose a karigar.") }))
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
  });

export type TeamInput = z.infer<typeof teamSchema>;

const MEMBER_SELECT = {
  where: { leftAt: null },
  // Members added together share joinedAt: name keeps their order stable.
  orderBy: [{ joinedAt: "asc" }, { karigar: { name: "asc" } }],
  select: {
    id: true,
    joinedAt: true,
    karigar: { select: { id: true, number: true, name: true, category: true, active: true } },
  },
} satisfies Prisma.JogadiTeam$membersArgs;

interface TeamWork {
  /** Jogadi: pieces issued and not yet received back. */
  held: number;
  /** Packing: pieces packed this month (posted entries). */
  packedThisMonth: number;
}

/** Work figures per team: pieces a Jogadi holds, pieces a packing team packed this month. */
async function teamWork(id: string | null): Promise<Map<string, TeamWork>> {
  const month = factoryToday().slice(0, 7) + "-01";
  const [held, packed] = await Promise.all([
    prisma.$queryRaw<{ team_id: string; pieces: number }[]>`
      SELECT i.team_id, sum(l.quantity - l.received)::int AS pieces
      FROM stitching_issue_lines l JOIN stitching_issues i ON i.id = l.issue_id
      WHERE i.status = 'POSTED' AND (${id}::uuid IS NULL OR i.team_id = ${id}::uuid)
      GROUP BY i.team_id`,
    prisma.$queryRaw<{ team_id: string; pieces: number }[]>`
      SELECT team_id, sum(pieces)::int AS pieces FROM packing_entries
      WHERE status = 'POSTED' AND team_id IS NOT NULL AND pack_date >= ${month}::date
        AND (${id}::uuid IS NULL OR team_id = ${id}::uuid)
      GROUP BY team_id`,
  ]);

  const work = new Map<string, TeamWork>();
  const at = (teamId: string) => {
    if (!work.has(teamId)) work.set(teamId, { held: 0, packedThisMonth: 0 });

    return work.get(teamId)!;
  };

  held.forEach((row) => (at(row.team_id).held = row.pieces));
  packed.forEach((row) => (at(row.team_id).packedThisMonth = row.pieces));

  return work;
}

async function teamDto(id: string) {
  const [team, work] = await Promise.all([
    prisma.jogadiTeam.findUnique({ where: { id }, include: { members: MEMBER_SELECT } }),
    teamWork(id),
  ]);

  if (!team) throw errors.notFound("Team");

  return toDto(team, work.get(id));
}

type TeamRecord = NonNullable<Awaited<ReturnType<typeof findTeams>>>[number];

function findTeams(filter: { activeOnly: boolean; kind: TeamKind | undefined }) {
  return prisma.jogadiTeam.findMany({
    where: { ...(filter.activeOnly ? { active: true } : {}), ...(filter.kind ? { kind: filter.kind } : {}) },
    orderBy: [{ active: "desc" }, { name: "asc" }],
    include: { members: MEMBER_SELECT },
  });
}

function toDto(team: TeamRecord, work: TeamWork | undefined) {
  return {
    id: team.id,
    code: team.code ?? "",
    kind: team.kind as TeamKind,
    name: team.name,
    active: team.active,
    notes: team.notes,
    createdAt: team.createdAt,
    members: team.members.map((member) => ({
      karigarId: member.karigar.id,
      code: karigarCode(member.karigar.number),
      name: member.karigar.name,
      category: member.karigar.category,
      active: member.karigar.active,
      joinedAt: member.joinedAt,
    })),
    /** Jogadi: pieces issued to the team and not yet received back. */
    piecesHeld: work?.held ?? 0,
    /** Packing: pieces the team packed this month. */
    packedThisMonth: work?.packedThisMonth ?? 0,
  };
}

export type TeamDto = ReturnType<typeof toDto>;

const duplicateName = () =>
  new AppError(409, ErrorCode.CONFLICT, "Another team already has this name.", {
    name: ["Another team already has this name."],
  });

/**
 * Refuses a name another team has (any case) before inserting, so a refused
 * duplicate does not use up a team code. The unique index still settles races.
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

export const teamService = {
  // ponytail: teams are a small master list, returned whole; page it if a factory ever has hundreds.
  async list(filter: { activeOnly: boolean; kind: TeamKind | undefined }): Promise<TeamDto[]> {
    const [teams, work] = await Promise.all([findTeams(filter), teamWork(null)]);

    return teams.map((team) => toDto(team, work.get(team.id)));
  },

  get: teamDto,

  async create(actor: AuthContext, input: TeamInput, meta: ClientMeta): Promise<TeamDto> {
    const kind = input.kind ?? "JOGADI";

    try {
      const id = await transaction(async (tx) => {
        await assertNameFree(tx, input.name, null);
        await assertMembers(tx, input, new Set());

        const team = await tx.jogadiTeam.create({
          data: {
            kind,
            name: input.name,
            active: input.active,
            notes: input.notes,
            createdById: actor.user.id,
            members: { createMany: { data: input.members.map((member) => ({ karigarId: member.karigarId })) } },
          },
          select: { id: true },
        });

        await recordAudit(tx, {
          type: "TEAM_CREATED",
          actorUserId: actor.user.id,
          sessionId: actor.sessionId,
          meta,
          metadata: { teamId: team.id, kind, name: input.name, members: input.members.length },
        });

        return team.id;
      });

      return await teamDto(id);
    } catch (error) {
      throw isUniqueViolation(error) ? duplicateName() : error;
    }
  },

  /** Renames, (de)activates and changes members. Leavers keep their history; given work keeps its snapshot. */
  async update(actor: AuthContext, id: string, input: TeamInput, meta: ClientMeta): Promise<TeamDto> {
    try {
      await transaction(async (tx) => {
        const [locked] = await tx.$queryRaw<
          { id: string; kind: TeamKind }[]
        >`SELECT id, kind FROM jogadi_teams WHERE id = ${id}::uuid FOR UPDATE`;

        if (!locked) throw errors.notFound("Team");

        if (input.kind && input.kind !== locked.kind) {
          throw fieldError("kind", "A team's type cannot change. Make a new team instead.");
        }

        await assertNameFree(tx, input.name, id);

        const current = await tx.jogadiMember.findMany({ where: { teamId: id, leftAt: null } });
        const currentIds = new Set(current.map((member) => member.karigarId));
        const next = new Set(input.members.map((member) => member.karigarId));

        await assertMembers(tx, input, currentIds);

        const leaving = current.filter((member) => !next.has(member.karigarId));
        const joining = input.members.filter((member) => !currentIds.has(member.karigarId));

        if (leaving.length > 0) {
          await tx.jogadiMember.updateMany({
            where: { id: { in: leaving.map((member) => member.id) } },
            data: { leftAt: new Date() },
          });
        }

        if (joining.length > 0) {
          await tx.jogadiMember.createMany({
            data: joining.map((member) => ({ teamId: id, karigarId: member.karigarId })),
          });
        }

        await tx.jogadiTeam.update({
          where: { id },
          data: { name: input.name, active: input.active, notes: input.notes },
        });
        await recordAudit(tx, {
          type: "TEAM_UPDATED",
          actorUserId: actor.user.id,
          sessionId: actor.sessionId,
          meta,
          metadata: {
            teamId: id,
            name: input.name,
            joined: joining.length,
            left: leaving.length,
            active: input.active,
          },
        });
      });

      return await teamDto(id);
    } catch (error) {
      throw isUniqueViolation(error) ? duplicateName() : error;
    }
  },
};

const idOf = (req: Request) => z.object({ id: z.uuid() }).parse(req.params).id;

export function teamRoutes(): Router {
  const router = Router();

  router.use(requireAuth);

  const manage = requirePermission("karigar.manage");
  // The team list feeds the Teams screen, the stitching issue form and the packing form.
  const view = requireAnyPermission("karigar.view", "stitching.view", "packing.view");

  router.get("/", view, (async (req, res) => {
    const query = z
      .object({ active: z.enum(["true", "false"]).optional(), kind: z.enum(TEAM_KINDS).optional() })
      .parse(req.query);
    const teams = await teamService.list({ activeOnly: query.active === "true", kind: query.kind });

    res.json({ success: true, data: { teams } });
  }) satisfies RequestHandler);

  router.get("/:id", view, (async (req, res) => {
    res.json({ success: true, data: { team: await teamService.get(idOf(req)) } });
  }) satisfies RequestHandler);

  router.post("/", manage, (async (req, res) => {
    const team = await teamService.create(actorOf(req), teamSchema.parse(req.body), clientMeta(req));

    res.status(201).json({ success: true, data: { team } });
  }) satisfies RequestHandler);

  router.put("/:id", manage, (async (req, res) => {
    const team = await teamService.update(actorOf(req), idOf(req), teamSchema.parse(req.body), clientMeta(req));

    res.json({ success: true, data: { team } });
  }) satisfies RequestHandler);

  return router;
}
