import { Router, type Request, type RequestHandler } from "express";
import { z } from "zod";

import { prisma, Prisma } from "../../db/prisma";
import { FACTORY_TIME_ZONE } from "../../lib/business-date";
import { allRows, sendCsv } from "../../lib/csv-export";
import { errors } from "../../lib/errors";
import { contains, page, where } from "../../lib/list-query";
import { requireAuth } from "../auth/auth.middleware";
import { requirePermission } from "../permissions/permission.middleware";
import {
  AUDIT_CATEGORIES,
  AUDIT_EVENTS,
  AUDIT_SEVERITIES,
  AUDIT_TYPES,
  ENTITY_KEYS,
  eventInfo,
  type AuditCategory,
  type AuditSeverity,
} from "./audit.catalog";

// Reading the audit log: every filter runs in SQL over the indexed table, and the same
// query string drives the list and its CSV export. Events are append-only (trigger).

const csv = (values: readonly string[]) =>
  z
    .string()
    .trim()
    .max(4000)
    .optional()
    .transform((text) => (text ? text.split(",").map((value) => value.trim()) : []))
    .refine((list) => list.every((value) => values.includes(value)), "Unknown value.");

export const auditQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  /** Done by this person. */
  actorId: z.uuid().optional(),
  /** Done to this person (their account). */
  targetId: z.uuid().optional(),
  /** Done by or to this person. */
  personId: z.uuid().optional(),
  role: z.string().trim().max(40).optional(),
  category: csv(AUDIT_CATEGORIES),
  type: csv(AUDIT_TYPES),
  severity: csv(AUDIT_SEVERITIES),
  outcome: z.enum(["success", "failure"]).optional(),
  ip: z.string().trim().max(60).optional(),
  sessionId: z.uuid().optional(),
  /** Any record named in the event (lot, entry, dispatch…). */
  recordId: z.uuid().optional(),
  sort: z.enum(["asc", "desc"]).default("desc"),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce
    .number()
    .int()
    .refine((size) => [10, 25, 50, 100].includes(size), "Use 10, 25, 50 or 100.")
    .default(25),
});

export type AuditQuery = z.infer<typeof auditQuerySchema>;

const typesWhere = (predicate: (info: (typeof AUDIT_EVENTS)[keyof typeof AUDIT_EVENTS]) => boolean) =>
  AUDIT_TYPES.filter((type) => predicate(AUDIT_EVENTS[type]));

function clauses(query: AuditQuery): Prisma.Sql[] {
  const sql: Prisma.Sql[] = [];
  const inTypes = (types: string[]) =>
    types.length ? Prisma.sql`e.event_type IN (${Prisma.join(types)})` : Prisma.sql`false`;

  if (query.from) {
    sql.push(Prisma.sql`e.created_at >= (${query.from}::date::timestamp AT TIME ZONE ${FACTORY_TIME_ZONE})`);
  }

  if (query.to) {
    sql.push(Prisma.sql`e.created_at < ((${query.to}::date + 1)::timestamp AT TIME ZONE ${FACTORY_TIME_ZONE})`);
  }

  if (query.actorId) sql.push(Prisma.sql`e.actor_user_id = ${query.actorId}::uuid`);

  if (query.targetId) sql.push(Prisma.sql`e.target_user_id = ${query.targetId}::uuid`);

  if (query.personId) {
    sql.push(Prisma.sql`(e.actor_user_id = ${query.personId}::uuid OR e.target_user_id = ${query.personId}::uuid)`);
  }

  if (query.role) sql.push(Prisma.sql`e.actor_role_key = ${query.role}`);

  if (query.category.length) {
    sql.push(inTypes(typesWhere((info) => (query.category as AuditCategory[]).includes(info.category))));
  }

  if (query.type.length) sql.push(inTypes(query.type));

  if (query.severity.length) {
    sql.push(inTypes(typesWhere((info) => (query.severity as AuditSeverity[]).includes(info.severity))));
  }

  if (query.outcome) {
    const failures = typesWhere((info) => "failure" in info);

    sql.push(
      query.outcome === "failure" ? inTypes(failures) : Prisma.sql`e.event_type NOT IN (${Prisma.join(failures)})`,
    );
  }

  if (query.ip) sql.push(Prisma.sql`host(e.ip_address) LIKE ${contains(query.ip)}`);

  if (query.sessionId) sql.push(Prisma.sql`e.session_id = ${query.sessionId}::uuid`);

  if (query.recordId) {
    sql.push(Prisma.sql`EXISTS (SELECT 1 FROM jsonb_each_text(e.metadata) m WHERE m.value = ${query.recordId})`);
  }

  if (query.q) {
    const pattern = contains(query.q);
    // Labels live in code: a search for "dispatch" also finds the event types so labelled.
    const labelled = AUDIT_TYPES.filter((type) =>
      AUDIT_EVENTS[type].label.toLowerCase().includes(query.q!.toLowerCase()),
    );

    sql.push(Prisma.sql`(
      lower(e.event_type) LIKE ${pattern}
      OR lower(COALESCE(e.actor_name, '')) LIKE ${pattern}
      OR lower(COALESCE(e.actor_role_name, '')) LIKE ${pattern}
      OR lower(COALESCE(t.name, '')) LIKE ${pattern}
      OR lower(COALESCE(t.email, '')) LIKE ${pattern}
      OR COALESCE(host(e.ip_address), '') LIKE ${pattern}
      OR lower(COALESCE(e.user_agent, '')) LIKE ${pattern}
      OR lower(e.metadata::text) LIKE ${pattern}
      OR e.request_id = ${query.q}
      ${labelled.length ? Prisma.sql`OR e.event_type IN (${Prisma.join(labelled)})` : Prisma.empty}
    )`);
  }

  return sql;
}

const FROM = Prisma.sql`FROM audit_events e LEFT JOIN users t ON t.id = e.target_user_id`;

interface Row {
  id: string;
  event_type: string;
  created_at: Date;
  actor_user_id: string | null;
  actor_name: string | null;
  actor_role_key: string | null;
  actor_role_name: string | null;
  target_user_id: string | null;
  target_name: string | null;
  target_login: string | null;
  session_id: string | null;
  ip: string | null;
  user_agent: string | null;
  request_id: string | null;
  metadata: Record<string, unknown>;
}

/** "Chrome 131 on Windows", from a user agent; no library, the common browsers only. */
export function describeDevice(userAgent: string | null): { browser: string; os: string; mobile: boolean } | null {
  if (!userAgent) return null;

  const ua = userAgent;
  const version = (pattern: RegExp) => pattern.exec(ua)?.[1]?.split(".")[0];
  const browser =
    (/Edg\//.test(ua) && `Edge ${version(/Edg\/([\d.]+)/) ?? ""}`) ||
    (/OPR\//.test(ua) && `Opera ${version(/OPR\/([\d.]+)/) ?? ""}`) ||
    (/Firefox\//.test(ua) && `Firefox ${version(/Firefox\/([\d.]+)/) ?? ""}`) ||
    (/Chrome\//.test(ua) && `Chrome ${version(/Chrome\/([\d.]+)/) ?? ""}`) ||
    (/Safari\//.test(ua) && /Version\//.test(ua) && `Safari ${version(/Version\/([\d.]+)/) ?? ""}`) ||
    (/curl|wget|python|node|axios|supertest|okhttp/i.test(ua) && "Script / tool") ||
    "Other browser";
  const os =
    (/Windows/.test(ua) && "Windows") ||
    (/Android/.test(ua) && "Android") ||
    (/iPhone|iPad|iPod/.test(ua) && "iOS") ||
    (/Mac OS X|Macintosh/.test(ua) && "macOS") ||
    (/Linux/.test(ua) && "Linux") ||
    "Unknown OS";

  return { browser: browser.trim(), os, mobile: /Mobi|Android|iPhone|iPad/.test(ua) };
}

function toEvent(row: Row) {
  const info = eventInfo(row.event_type);
  const entityKey = ENTITY_KEYS.find((key) => typeof row.metadata[key] === "string");
  const reason = typeof row.metadata.reason === "string" ? row.metadata.reason : null;

  return {
    id: row.id,
    at: row.created_at,
    type: row.event_type,
    label: info.label,
    category: info.category,
    severity: info.severity,
    outcome: info.failure ? ("failure" as const) : ("success" as const),
    actor: row.actor_user_id
      ? {
          id: row.actor_user_id,
          name: row.actor_name ?? "Unknown",
          roleKey: row.actor_role_key,
          roleName: row.actor_role_name,
        }
      : null,
    target: row.target_user_id ? { id: row.target_user_id, name: row.target_name, login: row.target_login } : null,
    record: entityKey ? { key: entityKey, id: row.metadata[entityKey] as string } : null,
    reason,
    // IPv4 clients reached over an IPv6 socket arrive as ::ffff:a.b.c.d; show the IPv4 address.
    ip: row.ip?.replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/, "$1") ?? null,
    userAgent: row.user_agent,
    device: describeDevice(row.user_agent),
    sessionId: row.session_id,
    requestId: row.request_id,
    metadata: row.metadata,
  };
}

const SELECT = Prisma.sql`
  SELECT e.id, e.event_type, e.created_at, e.actor_user_id, e.actor_name, e.actor_role_key, e.actor_role_name,
         e.target_user_id, t.name AS target_name, COALESCE(t.email, t.phone) AS target_login, e.session_id,
         host(e.ip_address) AS ip, e.user_agent, e.request_id, e.metadata`;

export const auditReadService = {
  async list(query: AuditQuery) {
    const filter = where(clauses(query));
    const order =
      query.sort === "asc" ? Prisma.sql`ORDER BY e.created_at ASC, e.id` : Prisma.sql`ORDER BY e.created_at DESC, e.id`;
    const failures = typesWhere((info) => "failure" in info);
    const critical = typesWhere((info) => info.severity === "critical");

    const [rows, [summary]] = await Promise.all([
      prisma.$queryRaw<Row[]>`${SELECT} ${FROM} ${filter} ${order} ${page(query)}`,
      prisma.$queryRaw<{ total: number; actors: number; failures: number; critical: number; ips: number }[]>`
        SELECT count(*)::int AS total, count(DISTINCT e.actor_user_id)::int AS actors,
               count(*) FILTER (WHERE e.event_type IN (${Prisma.join(failures)}))::int AS failures,
               count(*) FILTER (WHERE e.event_type IN (${Prisma.join(critical)}))::int AS critical,
               count(DISTINCT e.ip_address)::int AS ips
        ${FROM} ${filter}`,
    ]);

    return {
      events: rows.map(toEvent),
      total: summary!.total,
      summary: {
        events: summary!.total,
        actors: summary!.actors,
        failures: summary!.failures,
        critical: summary!.critical,
        ips: summary!.ips,
      },
    };
  },

  async get(id: string) {
    const [row] = await prisma.$queryRaw<Row[]>`${SELECT} ${FROM} WHERE e.id = ${id}::uuid`;

    if (!row) throw errors.notFound("Audit event");

    return toEvent(row);
  },

  /** What the filters offer: every event type with its label, the categories, and who appears in the log. */
  async facets() {
    const [actors, roles] = await Promise.all([
      prisma.$queryRaw<{ id: string; name: string; role: string | null }[]>`
        SELECT DISTINCT ON (e.actor_user_id) e.actor_user_id AS id, COALESCE(u.name, e.actor_name, 'Unknown') AS name,
               e.actor_role_name AS role
        FROM audit_events e LEFT JOIN users u ON u.id = e.actor_user_id
        WHERE e.actor_user_id IS NOT NULL ORDER BY e.actor_user_id, e.created_at DESC`,
      prisma.$queryRaw<{ key: string; name: string }[]>`
        SELECT DISTINCT actor_role_key AS key, actor_role_name AS name FROM audit_events
        WHERE actor_role_key IS NOT NULL ORDER BY 2`,
    ]);

    return {
      types: AUDIT_TYPES.map((type) => ({ type, ...AUDIT_EVENTS[type] })),
      categories: AUDIT_CATEGORIES,
      severities: AUDIT_SEVERITIES,
      actors: actors.sort((a, b) => a.name.localeCompare(b.name)),
      roles,
    };
  },
};

const idOf = (req: Request) => z.object({ id: z.uuid() }).parse(req.params).id;

export function auditRoutes(): Router {
  const router = Router();

  router.use(requireAuth, requirePermission("audit.view"));

  router.get("/", (async (req, res) => {
    res.json({ success: true, data: await auditReadService.list(auditQuerySchema.parse(req.query)) });
  }) satisfies RequestHandler);

  router.get("/facets", (async (_req, res) => {
    res.json({ success: true, data: await auditReadService.facets() });
  }) satisfies RequestHandler);

  router.get("/export", (async (req, res) => {
    const { events } = await auditReadService.list(allRows(auditQuerySchema.parse(req.query)));
    type Event = (typeof events)[number];

    sendCsv(
      req,
      res,
      "audit-log",
      [
        { header: "Time", value: (row: Event) => row.at },
        { header: "Action", value: (row: Event) => row.label },
        { header: "Event type", value: (row: Event) => row.type },
        { header: "Area", value: (row: Event) => row.category },
        { header: "Severity", value: (row: Event) => row.severity },
        { header: "Outcome", value: (row: Event) => row.outcome },
        { header: "Done by", value: (row: Event) => row.actor?.name ?? "" },
        { header: "Their role", value: (row: Event) => row.actor?.roleName ?? "" },
        { header: "Done to", value: (row: Event) => row.target?.name ?? row.target?.login ?? "" },
        { header: "Reason", value: (row: Event) => row.reason ?? "" },
        { header: "IP address", value: (row: Event) => row.ip ?? "" },
        { header: "Device", value: (row: Event) => (row.device ? `${row.device.browser} on ${row.device.os}` : "") },
        { header: "Session", value: (row: Event) => row.sessionId ?? "" },
        { header: "Request id", value: (row: Event) => row.requestId ?? "" },
        { header: "Details", value: (row: Event) => JSON.stringify(row.metadata) },
      ],
      events,
      (row) => row.id,
    );
  }) satisfies RequestHandler);

  router.get("/:id", (async (req, res) => {
    res.json({ success: true, data: { event: await auditReadService.get(idOf(req)) } });
  }) satisfies RequestHandler);

  return router;
}
