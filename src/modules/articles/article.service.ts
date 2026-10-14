import { isUniqueViolation, prisma, Prisma, transaction, type Db } from "../../db/prisma";
import { AppError, ErrorCode, errors } from "../../lib/errors";
import { columnFilters, contains, orderBy, page, where } from "../../lib/list-query";
import { recordAudit } from "../audit/audit.service";
import { markerDefaultsSchema, type MarkerDefaults } from "../cutting/cutting.schema";
import type { AuthContext, ClientMeta } from "../sessions/session.types";
import { ARTICLE_COLUMNS, type ArticleInput, type ArticleListQuery, type SizeTemplateInput } from "./article.schema";

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

export interface SizeTemplateDto {
  id: string;
  name: string;
  sizes: string[];
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

async function findById(db: Db, id: string): Promise<ArticleDto | null> {
  const [row] = await db.$queryRaw<ArticleRow[]>`SELECT ${SELECT} ${FROM} WHERE a.id = ${id}::uuid`;

  return row ? toArticle(row) : null;
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

async function assertFabric(db: Db, fabricId: string | null): Promise<void> {
  if (!fabricId) return;

  const fabric = await db.fabric.findUnique({ where: { id: fabricId }, select: { id: true } });

  if (!fabric) throw fieldError("defaultFabricId", "Choose a fabric.");
}

async function save(db: Db, actor: AuthContext, input: ArticleInput, id: string | null): Promise<string> {
  const sameName = await findByName(db, input.name);

  if (sameName && sameName.id !== id) {
    throw fieldError("name", `${sameName.name} (${sameName.code}) already exists. Use it instead.`, 409);
  }

  await assertFabric(db, input.defaultFabricId);

  const data = {
    name: input.name,
    // Updates always pass the current code, so only creations draw a new one.
    code: input.code ?? (await nextCode(db)),
    defaultFabricId: input.defaultFabricId,
    defaultMarker: input.defaultMarker ?? Prisma.DbNull,
    active: input.active,
  };

  if (id) {
    await db.article.update({ where: { id }, data });

    return id;
  }

  const created = await db.article.create({
    data: { ...data, createdById: actor.user.id },
    select: { id: true },
  });

  return created.id;
}


export const articleService = {
  async list(query: ArticleListQuery): Promise<{ articles: ArticleDto[]; total: number }> {
    const clauses = columnFilters(ARTICLE_COLUMNS, query);

    if (query.search) clauses.push(Prisma.sql`a.search_text LIKE ${contains(query.search)}`);

    const filter = where(clauses);
    const order = orderBy(ARTICLE_COLUMNS, query, "a.active DESC, a.name", "a.id");

    const [rows, [count]] = await Promise.all([
      prisma.$queryRaw<ArticleRow[]>`SELECT ${SELECT} ${FROM} ${filter} ${order} ${page(query)}`,
      prisma.$queryRaw<{ total: number }[]>`SELECT count(*)::int AS total ${FROM} ${filter}`,
    ]);

    return { articles: rows.map(toArticle), total: count!.total };
  },

  /** Active articles for the production form's search-or-create picker. */
  async options(): Promise<ArticleDto[]> {
    const rows = await prisma.$queryRaw<ArticleRow[]>`SELECT ${SELECT} ${FROM} WHERE a.active ORDER BY a.name LIMIT 1000`;

    return rows.map(toArticle);
  },

  async get(id: string): Promise<ArticleDto> {
    const article = await findById(prisma, id);

    if (!article) throw errors.notFound("Item");

    return article;
  },

  async create(actor: AuthContext, input: ArticleInput, meta: ClientMeta): Promise<ArticleDto> {
    try {
      return await transaction(async (tx) => {
        const id = await save(tx, actor, input, null);

        await recordAudit(tx, { type: "ARTICLE_CREATED", ...audit(actor, meta), metadata: { articleId: id } });

        return (await findById(tx, id))!;
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw fieldError("code", "Another item already uses this code.", 409);

      throw error;
    }
  },

  async update(actor: AuthContext, id: string, input: ArticleInput, meta: ClientMeta): Promise<ArticleDto> {
    try {
      return await transaction(async (tx) => {
        const existing = await tx.article.findUnique({ where: { id }, select: { code: true } });

        if (!existing) throw errors.notFound("Item");

        // Lots keep their own snapshot of code and name, so renaming never rewrites history.
        await save(tx, actor, { ...input, code: input.code ?? existing.code }, id);
        await recordAudit(tx, { type: "ARTICLE_UPDATED", ...audit(actor, meta), metadata: { articleId: id } });

        return (await findById(tx, id))!;
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw fieldError("code", "Another item already uses this code.", 409);

      throw error;
    }
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
      const article = await tx.article.findUnique({ where: { id: ref.id }, select: { id: true, code: true, name: true, active: true } });

      if (!article?.active) throw fieldError("article", "Choose an active item.");

      return article;
    }

    const existing = await findByName(tx, ref.name);

    if (existing) return existing;

    const id = await save(tx, actor, { name: ref.name, code: ref.code, defaultFabricId, defaultMarker: null, active: true }, null);

    await recordAudit(tx, { type: "ARTICLE_CREATED", ...audit(actor, meta), metadata: { articleId: id, inline: true } });

    return (await tx.article.findUnique({ where: { id }, select: { id: true, code: true, name: true } }))!;
  },

  /** Remembers a batch's marker and ratio as the article's default for its next lot. */
  async saveDefaults(tx: Prisma.TransactionClient, articleId: string, marker: MarkerDefaults): Promise<void> {
    await tx.article.update({ where: { id: articleId }, data: { defaultMarker: marker } });
  },
};

export const sizeTemplateService = {
  async list(): Promise<SizeTemplateDto[]> {
    return prisma.sizeTemplate.findMany({ select: { id: true, name: true, sizes: true }, orderBy: { name: "asc" } });
  },

  async save(actor: AuthContext, id: string | null, input: SizeTemplateInput, meta: ClientMeta): Promise<SizeTemplateDto> {
    try {
      return await transaction(async (tx) => {
        const select = { id: true, name: true, sizes: true };

        const template = id
          ? await tx.sizeTemplate.update({ where: { id }, data: input, select })
          : await tx.sizeTemplate.create({ data: { ...input, createdById: actor.user.id }, select });

        await recordAudit(tx, { type: "SIZE_TEMPLATE_SAVED", ...audit(actor, meta), metadata: { templateId: template.id } });

        return template;
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw fieldError("name", "Another template already uses this name.", 409);

      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") throw errors.notFound("Size template");

      throw error;
    }
  },

  async remove(actor: AuthContext, id: string, meta: ClientMeta): Promise<void> {
    await transaction(async (tx) => {
      const { count } = await tx.sizeTemplate.deleteMany({ where: { id } });

      if (count === 0) throw errors.notFound("Size template");

      await recordAudit(tx, { type: "SIZE_TEMPLATE_DELETED", ...audit(actor, meta), metadata: { templateId: id } });
    });
  },
};
