import { prisma, Prisma, transaction, type Db } from "../../db/prisma";
import { AppError, ErrorCode, errors } from "../../lib/errors";
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

  /** Deletes an item typed by mistake. One used by a lot or the godown is merged instead. */
  async remove(actor: AuthContext, id: string, meta: ClientMeta): Promise<void> {
    await transaction(async (tx) => {
      const [article] = await tx.$queryRaw<{ name: string; lots: number; moves: number }[]>`
        SELECT a.name,
               (SELECT count(*)::int FROM production_lots WHERE article_id = a.id) AS lots,
               (SELECT count(*)::int FROM godown_movements WHERE article_id = a.id) AS moves
        FROM articles a WHERE a.id = ${id}::uuid FOR UPDATE`;

      if (!article) throw errors.notFound("Item");

      if (article.lots > 0 || article.moves > 0) {
        throw errors.conflict(
          `${article.name} is used by ${article.lots} lot${article.lots === 1 ? "" : "s"}. Merge it into another item instead of deleting.`,
        );
      }

      await tx.article.delete({ where: { id } });
      await recordAudit(tx, {
        type: "ARTICLE_DELETED",
        ...audit(actor, meta),
        metadata: { articleId: id, name: article.name },
      });
    });
  },

  /**
   * Merges near-duplicate items ("trouser", "Trousers", "Black trouser") into one: their lots
   * and godown stock move to the item kept, then they are removed. One transaction.
   */
  async merge(actor: AuthContext, input: { targetId: string; sourceIds: string[] }, meta: ClientMeta) {
    const sourceIds = [...new Set(input.sourceIds)];

    if (sourceIds.length === 0) throw fieldError("sourceIds", "Choose the items to merge.");

    if (sourceIds.includes(input.targetId)) throw fieldError("sourceIds", "An item cannot be merged into itself.");

    return transaction(async (tx) => {
      const ids = [input.targetId, ...sourceIds];

      // Stock rows first, the order dispatch, count and reversal lock them in: a dispatch running
      // now finishes first, and one waiting finds the merged item's stock afterwards.
      await tx.$queryRaw`
        SELECT 1 FROM godown_stock WHERE article_id IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})
        ORDER BY article_id, size_label FOR UPDATE`;

      const locked = await tx.$queryRaw<{ id: string; code: string; name: string }[]>`
        SELECT id, code, name FROM articles WHERE id IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})
        ORDER BY id FOR UPDATE`;
      const target = locked.find((article) => article.id === input.targetId);

      if (!target) throw fieldError("targetId", "Choose the item to keep.");

      if (locked.length !== ids.length)
        throw fieldError("sourceIds", "An item to merge no longer exists. Reload and try again.");

      const sources = Prisma.join(sourceIds.map((id) => Prisma.sql`${id}::uuid`));

      const lots = await tx.$executeRaw`
        UPDATE production_lots SET article_id = ${target.id}::uuid, article_code = ${target.code},
               article_name = ${target.name}, updated_at = now()
        WHERE article_id IN (${sources})`;

      // The godown ledger keeps every row; only the item it counts moves. The stock projection is rebuilt.
      await tx.$executeRaw`UPDATE godown_movements SET article_id = ${target.id}::uuid WHERE article_id IN (${sources})`;
      await tx.$executeRaw`
        DELETE FROM godown_stock WHERE article_id IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})`;
      await tx.$executeRaw`
        INSERT INTO godown_stock (article_id, size_label, qty_in, qty_out, balance, last_movement_at)
        SELECT article_id, size_label, sum(qty_in), sum(qty_out), sum(qty_in) - sum(qty_out), max(created_at)
        FROM godown_movements WHERE article_id = ${target.id}::uuid GROUP BY 1, 2`;
      await tx.$executeRaw`DELETE FROM articles WHERE id IN (${sources})`;
      await recordAudit(tx, {
        type: "ARTICLES_MERGED",
        ...audit(actor, meta),
        metadata: {
          targetId: target.id,
          merged: locked.filter((article) => article.id !== target.id).map((article) => article.name),
          lots,
        },
      });

      return { article: { id: target.id, code: target.code, name: target.name }, lots, removed: sourceIds.length };
    });
  },

  /** Remembers a batch's marker and ratio as the article's default for its next lot. */
  async saveDefaults(tx: Prisma.TransactionClient, articleId: string, marker: MarkerDefaults): Promise<void> {
    await tx.article.update({ where: { id: articleId }, data: { defaultMarker: marker } });
  },
};
