import { Router, type Request, type RequestHandler } from "express";
import { z } from "zod";

import { CATEGORY_LABEL, karigarCode, label, PAY_MODE_LABEL } from "../../lib/labels";
import { allRows, sendCsv } from "../../lib/csv-export";
import { actorOf, can, clientMeta } from "../../lib/request";
import { requireAuth } from "../auth/auth.middleware";
import { requireAnyPermission, requirePermission } from "../permissions/permission.middleware";
import {
  karigarListQuerySchema,
  karigarOptionsQuerySchema,
  karigarSchema,
  type KarigarListQuery,
} from "./karigar.schema";
import { karigarService, type PayVisibility } from "./karigar.service";

const idOf = (req: Request) => z.object({ id: z.uuid() }).parse(req.params).id;

// Rates are needed to set a karigar up; lifetime earnings are payroll data.
const payOf = (req: Request): PayVisibility => ({
  rate: can(req, "costing.view") || can(req, "karigar.manage"),
  earned: can(req, "costing.view"),
});

export function karigarRoutes(): Router {
  const router = Router();

  router.use(requireAuth);

  const manage = requirePermission("karigar.manage");

  router.get("/", requirePermission("karigar.view"), (async (req, res) => {
    // SAFETY: column params are validated by the schema; their keys are dynamic.
    const query = karigarListQuerySchema.parse(req.query) as KarigarListQuery;

    res.json({ success: true, data: await karigarService.list(query, payOf(req)) });
  }) satisfies RequestHandler);

  router.get("/export", requirePermission("karigar.view"), (async (req, res) => {
    // SAFETY: column params are validated by the schema; their keys are dynamic.
    const query = karigarListQuerySchema.parse(req.query) as KarigarListQuery;
    const pay = payOf(req);
    const { karigars } = await karigarService.list(allRows(query), pay);
    type Person = (typeof karigars)[number];

    sendCsv(
      req,
      res,
      "staff-and-karigars",
      [
        { header: "Code", value: (k: Person) => karigarCode(k.number) },
        { header: "Name", value: (k: Person) => k.name },
        { header: "Phone", value: (k: Person) => k.phone },
        { header: "Works as", value: (k: Person) => label(CATEGORY_LABEL, k.category) },
        { header: "Paid", value: (k: Person) => label(PAY_MODE_LABEL, k.payMode) },
        ...(pay.rate ? [{ header: "Rate", value: (k: Person) => k.payRate }] : []),
        ...(pay.earned ? [{ header: "Earned", value: (k: Person) => k.earned }] : []),
        { header: "Login", value: (k: Person) => k.user?.email ?? k.user?.phone },
        { header: "Status", value: (k: Person) => (k.active ? "Active" : "Inactive") },
        { header: "Notes", value: (k: Person) => k.notes },
      ],
      karigars,
      (k) => k.id,
    );
  }) satisfies RequestHandler);

  // Pickers (cutting master, Jogadi members, rework assignee, packer, payee), so those screens' users can choose people.
  router.get(
    "/options",
    requireAnyPermission("production.view", "karigar.view", "stitching.view", "packing.manage", "payments.view"),
    (async (req, res) => {
      const { category } = karigarOptionsQuerySchema.parse(req.query);

      res.json({ success: true, data: { karigars: await karigarService.options(category) } });
    }) satisfies RequestHandler,
  );

  router.get("/:id", requirePermission("karigar.view"), (async (req, res) => {
    res.json({ success: true, data: { karigar: await karigarService.get(idOf(req), payOf(req)) } });
  }) satisfies RequestHandler);

  router.post("/", manage, (async (req, res) => {
    const saved = await karigarService.create(actorOf(req), karigarSchema.parse(req.body), clientMeta(req), payOf(req));

    res.setHeader("Cache-Control", "no-store");
    res.status(201).json({ success: true, data: saved });
  }) satisfies RequestHandler);

  router.put("/:id", manage, (async (req, res) => {
    const saved = await karigarService.update(
      actorOf(req),
      idOf(req),
      karigarSchema.parse(req.body),
      clientMeta(req),
      payOf(req),
    );

    res.setHeader("Cache-Control", "no-store");
    res.json({ success: true, data: saved });
  }) satisfies RequestHandler);

  return router;
}
