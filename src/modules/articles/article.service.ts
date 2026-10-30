import { prisma, Prisma, type Db } from "../../db/prisma";
import { AppError, ErrorCode } from "../../lib/errors";
import { recordAudit } from "../audit/audit.service";
import { markerDefaultsSchema, type MarkerDefaults } from "../cutting/cutting.schema";
import type { AuthContext, ClientMeta } from "../sessions/session.types";

export interface ArticleDto {
  id: string;
  code: string;
  name: string;
  active: boolean;
  defaultFabric: { id: string; code: string; name: string; unit: string } | null;
  defaultMarker: MarkerDefaults | null;
  lots: number;
  createdAt: Date;
}

interface ArticleRow {
  id: string;
  code: string;
  name: string;
  active: boolean;
  default_marker: Prisma.JsonValue;
  fabric_id: string | null;
  fabric_code: string | null;
  fabric_name: string | null;
  fabric_unit: string | null;
  lots: number;
  created_at: Date;
}

const SELECT = Prisma.raw(`
  a.id, a.code, a.name, a.active, a.default_marker, a.created_at, f.id AS fabric_id, f.code AS fabric_code,
  f.name AS fabric_name, f.unit AS fabric_unit, COALESCE(l.lots, 0)::int AS lots`);

const FROM = Prisma.raw(`
  FROM articles a
  LEFT JOIN fabrics f ON f.id = a.default_fabric_id
  LEFT JOIN (SELECT article_id, count(*) AS lots FROM production_lots GROUP BY article_id) l ON l.article_id = a.id`);

/** Stored defaults are re-validated on the way out; anything unreadable is dropped, not trusted. */
function markerOf(value: Prisma.JsonValue): MarkerDefaults | null {
  const parsed = markerDefaultsSchema.safeParse(value);

  return parsed.success ? parsed.data : null;
}

function toArticle(row: ArticleRow): ArticleDto {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    active: row.active,
    defaultFabric:
      row.fabric_id && row.fabric_code && row.fabric_name && row.fabric_unit
        ? { id: row.fabric_id, code: row.fabric_code, name: row.fabric_name, unit: row.fabric_unit }
        : null,
    defaultMarker: markerOf(row.default_marker),
    lots: row.lots,
    createdAt: row.created_at,
  };
}

function fieldError(field: string, message: string, status = 400): AppError {
  return new AppError(status, status === 409 ? ErrorCode.CONFLICT : ErrorCode.VALIDATION_ERROR, message, {
    [field]: [message],
  });
}

function audit(actor: AuthContext, meta: ClientMeta) {
  return { actorUserId: actor.user.id, sessionId: actor.sessionId, meta };
}

/** The article whose name matches once case, spacing and punctuation are ignored. */
async function findByName(db: Db, name: string): Promise<{ id: string; code: string; name: string } | null> {
  const [row] = await db.$queryRaw<{ id: string; code: string; name: string }[]>`
    SELECT id, code, name FROM articles WHERE name_key = lower(regexp_replace(${name}, '[^[:alnum:]]+', '', 'g'))`;

  return row ?? null;
}

/** Next free ART-0001 style code, serialized so two creations never pick the same one. */
async function nextCode(db: Db): Promise<string> {
  await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('articles.code'))`;

  const [row] = await db.$queryRaw<{ next: number }[]>`
    SELECT COALESCE(max(substring(code FROM '^ART-(\\d+)$')::int), 0) + 1 AS next FROM articles`;

  return `ART-${String(row!.next).padStart(4, "0")}`;
}

export const articleService = {
  /** Active articles for the production form's search-or-create picker. */
  async options(): Promise<ArticleDto[]> {
    const rows = await prisma.$queryRaw<
      ArticleRow[]
    >`SELECT ${SELECT} ${FROM} WHERE a.active ORDER BY a.name LIMIT 1000`;

    return rows.map(toArticle);
  },

  /**
   * The article a new lot is for: an existing one by id, or one typed inline. A typed
   * name matching an existing article (ignoring case, spacing and punctuation) reuses it
   * rather than creating a near-duplicate.
   */
  async resolve(
    tx: Prisma.TransactionClient,
    actor: AuthContext,
    ref: { id: string } | { name: string; code: string | null },
    defaultFabricId: string,
    meta: ClientMeta,
  ): Promise<{ id: string; code: string; name: string }> {
    if ("id" in ref) {
      const article = await tx.article.findUnique({
        where: { id: ref.id },
        select: { id: true, code: true, name: true, active: true },
      });

      if (!article?.active) throw fieldError("article", "Choose an active item.");

      return article;
    }

    const existing = await findByName(tx, ref.name);

    if (existing) return existing;

    // The name was just found to be free and the caller has checked the fabric, so save()'s
    // checks would only repeat those round trips.
    const article = await tx.article.create({
      data: {
        name: ref.name,
        code: ref.code ?? (await nextCode(tx)),
        defaultFabricId,
        defaultMarker: Prisma.DbNull,
        active: true,
        createdById: actor.user.id,
      },
      select: { id: true, code: true, name: true },
    });

    await recordAudit(tx, {
      type: "ARTICLE_CREATED",
      ...audit(actor, meta),
      metadata: { articleId: article.id, inline: true },
    });

    return article;
  },

  /** Remembers a batch's marker and ratio as the article's default for its next lot. */
  async saveDefaults(tx: Prisma.TransactionClient, articleId: string, marker: MarkerDefaults): Promise<void> {
    await tx.article.update({ where: { id: articleId }, data: { defaultMarker: marker } });
  },
};
