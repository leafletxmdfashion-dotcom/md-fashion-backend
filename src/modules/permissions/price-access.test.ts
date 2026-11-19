import type { Router } from "express";
import { beforeEach, describe, expect, it } from "vitest";

import { post, stitchedLot, today } from "../../test/fixtures";
import { createUser, loggedInClient, resetDatabase, sql } from "../../test/helpers";
import { articleRoutes } from "../articles/article.routes";
import { cuttingRoutes, lotRoutes } from "../cutting/cutting.routes";
import { dashboardRoutes } from "../dashboard/dashboard";
import { fabricRoutes } from "../fabrics/fabric.routes";
import { godownRoutes } from "../godown/godown.routes";
import { karigarRoutes } from "../karigars/karigar.routes";
import { packingRoutes } from "../packing/packing.routes";
import { stitchingRoutes } from "../stitching/stitching.routes";
import { teamRoutes } from "../teams/teams";

// Prices and costs are sensitive. A person without "See prices & costs" (here an Admin with a
// per-person DENY) must get no money from any screen or export of the production modules.
// Every GET route is read from the routers themselves, so a new endpoint is swept automatically;
// one whose path parameters cannot be filled must be listed in UNREACHED on purpose.

beforeEach(resetDatabase);

const MODULES: [string, () => Router][] = [
  ["/fabrics", fabricRoutes],
  ["/karigars", karigarRoutes],
  ["/articles", articleRoutes],
  ["/production-lots", lotRoutes],
  ["/cutting-batches", cuttingRoutes],
  ["/teams", teamRoutes],
  ["/stitching", stitchingRoutes],
  ["/packing", packingRoutes],
  ["/godown", godownRoutes],
  ["/dashboard", dashboardRoutes],
];

/** GET routes whose parameters the sweep cannot fill (no such document in the fixture). */
const UNREACHED = new Set(["/godown/dispatches/:id"]);

/** People's accounts (what is owed to staff) belong to the separate Payments right, not to prices. */
const PAYMENTS_RIGHT = /^\/dashboard → payments\./;

/** Keys that carry money when they have a value. Quantities ("balance", "pieces") are not money. */
const MONEY_KEY =
  /^(rate|avgRate|payRate|amount|earning|earned|earnings|cost|costs|totalCost|stockValue|value|purchasedAmount|fabricCost|labourCost|costPerPiece|paid|payable|earningThisMonth|lastRate)$/i;

/** CSV headers that name money. */
const MONEY_HEADER = /\b(rate|amount|cost|value|earn(ed|ing)?|rs|price)\b/i;

function getRoutes(): string[] {
  return MODULES.flatMap(([prefix, build]) =>
    build()
      // SAFETY: Express keeps each route's methods on the route; its types leave them out.
      .stack.filter(
        (layer) => (layer.route as unknown as { methods?: Record<string, boolean> } | undefined)?.methods?.get,
      )
      .map((layer) => `${prefix}${layer.route!.path === "/" ? "" : layer.route!.path}`),
  );
}

function moneyIn(value: unknown, path = ""): string[] {
  if (Array.isArray(value)) return value.flatMap((item, index) => moneyIn(item, `${path}[${index}]`));

  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, child]) => {
      const at = path ? `${path}.${key}` : key;
      const scalar = child !== null && child !== undefined && typeof child !== "object";

      return MONEY_KEY.test(key) && scalar && Number(child) !== 0 ? [at] : moneyIn(child, at);
    });
  }

  return [];
}

const userId = async (email: string) =>
  (await sql("SELECT id FROM users WHERE email = $1", [email])).rows[0].id as string;

const override = (id: string, effect: "ALLOW" | "DENY") =>
  sql(
    "INSERT INTO user_permission_overrides (user_id, permission, effect, reason) VALUES ($1, 'costing.view', $2, 'Test')",
    [id, effect],
  );

describe("price & cost access", () => {
  it("shows no money anywhere to a person denied See prices & costs, and all of it to the owner", async () => {
    const { owner, lotId, teamId, fabricId, ram } = await stitchedLot();

    // A packing entry, so packing is swept with money in it.
    const packer = (
      await post(owner, "/api/v1/karigars", { name: "Puja", category: "PACKING_STAFF", payMode: "PER_PIECE", payRate: 2 })
    ).karigar.id as string;
    const entry = (
      await post(owner, "/api/v1/packing/entries", {
        lotId,
        packerId: packer,
        rate: 1.5,
        packDate: today,
        lines: [{ sizeLabel: "S", quantity: 5 }],
      })
    ).entry as { id: string };
    const issueId = (await sql("SELECT id FROM stitching_issues ORDER BY number LIMIT 1")).rows[0].id as string;
    const batchId = (await sql("SELECT id FROM cutting_batches LIMIT 1")).rows[0].id as string;
    const articleId = (await sql("SELECT article_id FROM production_lots WHERE id = $1", [lotId])).rows[0]
      .article_id as string;

    await createUser({ email: "admin@garment.test", role: "ADMIN" });
    await override(await userId("admin@garment.test"), "DENY");

    const admin = await loggedInClient("admin@garment.test");
    const ids: Record<string, string> = {
      "/fabrics/:id": fabricId,
      "/karigars/:id": ram,
      "/production-lots/:id": lotId,
      "/cutting-batches/:id": batchId,
      "/teams/:id": teamId,
      "/stitching/issues/:id": issueId,
      "/stitching/lots/:id/balance": lotId,
      "/packing/entries/:id": entry.id,
      "/godown/:articleId": articleId,
    };

    const leaks: string[] = [];
    const swept: string[] = [];

    for (const route of getRoutes()) {
      if (UNREACHED.has(route)) continue;

      const filled = route.includes(":") ? ids[route] : "";

      expect(filled, `Fill the parameter of ${route} in the sweep, or list it in UNREACHED`).toBeDefined();

      const path = filled ? route.replace(/:[A-Za-z]+/, filled) : route;
      const query = route === "/packing/last-rate" ? `?lotId=${lotId}` : "";
      const res = await admin.get(`/api/v1${path}${query}`);

      if (res.status === 403) continue;

      expect(res.status, `${route}: ${JSON.stringify(res.body).slice(0, 200)}`).toBe(200);
      swept.push(route);

      if (route.endsWith("/export")) {
        const header = res.text.trimStart().split(/\r?\n/)[0] ?? "";
        const money = header.split(",").filter((column) => MONEY_HEADER.test(column));

        if (money.length > 0) leaks.push(`${route} CSV: ${money.join(", ")}`);
      } else {
        for (const at of moneyIn(res.body.data)) leaks.push(`${route} → ${at}`);
      }
    }

    expect(swept.length).toBeGreaterThan(30);
    expect(leaks.filter((leak) => !PAYMENTS_RIGHT.test(leak))).toEqual([]);

    // The owner sees the same screens with their money.
    expect((await owner.get(`/api/v1/stitching/issues/${issueId}`)).body.data.issue.rate).not.toBeNull();
    expect((await owner.get(`/api/v1/packing/entries/${entry.id}`)).body.data.entry.earning).toBe("7.50");
  });

  it("gives prices to Owner and Admin only by default, and to one person when the owner chooses", async () => {
    const { owner } = await stitchedLot();
    const roles = (await owner.get("/api/v1/roles")).body.data.roles as { key: string; permissions: string[] }[];
    const holders = roles.filter((role) => role.permissions.includes("costing.view")).map((role) => role.key);

    expect(holders.filter((key) => key !== "OWNER")).toEqual(["ADMIN"]);

    await createUser({ email: "manager@garment.test", role: "MANAGER" });

    const fabrics = async () =>
      (await (await loggedInClient("manager@garment.test")).get("/api/v1/fabrics")).body.data.fabrics as {
        avgRate: number | null;
      }[];

    expect((await fabrics()).every((fabric) => fabric.avgRate === null)).toBe(true);

    // One person, not the whole role.
    await override(await userId("manager@garment.test"), "ALLOW");

    expect((await fabrics())[0]!.avgRate).not.toBeNull();
  });
});
