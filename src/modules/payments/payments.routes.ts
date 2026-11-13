import { Router, type Request, type RequestHandler } from "express";

import { allRows, sendCsv, type CsvColumn } from "../../lib/csv-export";
import { CATEGORY_LABEL, karigarCode, label } from "../../lib/labels";
import { actorOf, clientMeta } from "../../lib/request";
import { requireAuth } from "../auth/auth.middleware";
import { requirePermission } from "../permissions/permission.middleware";
import {
  entrySchema,
  idParamsSchema,
  ledgerQuerySchema,
  peopleQuerySchema,
  reverseSchema,
  type LedgerQuery,
  type PeopleQuery,
} from "./payments.schema";
import { paymentsService } from "./payments.service";

const idOf = (req: Request) => idParamsSchema.parse(req.params).id;

// SAFETY: column params are validated by the schema; their keys are dynamic.
const ledgerQuery = (req: Request) => ledgerQuerySchema.parse(req.query) as LedgerQuery;

type Entry = Awaited<ReturnType<typeof paymentsService.ledger>>["entries"][number];

const METHOD_LABEL: Record<string, string> = { CASH: "Cash", BANK: "Bank", WALLET: "eSewa / wallet" };

/** Ledger rows as CSV: + is owed to the person, − is what they owe or were paid. */
function ledgerColumns(withPerson: boolean): CsvColumn<Entry>[] {
  return [
    { header: "Date", value: (e) => e.date },
    ...(withPerson
      ? [
          { header: "Code", value: (e: Entry) => karigarCode(e.karigar.number) },
          { header: "Person", value: (e: Entry) => e.karigar.name },
        ]
      : []),
    { header: "Entry", value: (e) => e.label },
    { header: "Details", value: (e) => e.description },
    { header: "Category", value: (e) => e.category },
    { header: "Paid by", value: (e) => (e.method ? (METHOD_LABEL[e.method] ?? e.method) : null) },
    { header: "Voucher / reference", value: (e) => e.reference },
    { header: "In (+)", value: (e) => (Number(e.amount) > 0 ? e.amount : null) },
    { header: "Out (−)", value: (e) => (Number(e.amount) < 0 ? e.amount.replace("-", "") : null) },
    { header: "Amount", value: (e) => e.amount },
    { header: "Balance after", value: (e) => e.balance },
    { header: "Reversed", value: (e) => e.reversed },
    { header: "By", value: (e) => e.createdBy },
  ];
}

export function paymentsRoutes(): Router {
  const router = Router();

  router.use(requireAuth);

  const view = requirePermission("payments.view");
  const manage = requirePermission("payments.manage");

  // Every signed-in person may see their own account, nobody else's.
  router.get("/me", (async (req, res) => {
    res.json({ success: true, data: await paymentsService.me(actorOf(req).user.id) });
  }) satisfies RequestHandler);

  router.get("/me/ledger", (async (req, res) => {
    res.json({ success: true, data: await paymentsService.myLedger(actorOf(req).user.id, ledgerQuery(req)) });
  }) satisfies RequestHandler);

  // Own ledger only: the person is taken from the login, never from the query.
  router.get("/me/ledger/export", (async (req, res) => {
    const { entries } = await paymentsService.myLedger(actorOf(req).user.id, allRows(ledgerQuery(req)));

    sendCsv(req, res, "my-ledger", ledgerColumns(false), entries, (e) => e.id);
  }) satisfies RequestHandler);

  router.get("/people", view, (async (req, res) => {
    // SAFETY: column params are validated by the schema; their keys are dynamic.
    const query = peopleQuerySchema.parse(req.query) as PeopleQuery;

    res.json({ success: true, data: await paymentsService.people(query) });
  }) satisfies RequestHandler);

  router.get("/people/export", view, (async (req, res) => {
    // SAFETY: column params are validated by the schema; their keys are dynamic.
    const query = peopleQuerySchema.parse(req.query) as PeopleQuery;
    const { people } = await paymentsService.people(allRows(query));

    sendCsv(
      req,
      res,
      "balances",
      [
        { header: "Code", value: (p) => karigarCode(p.number) },
        { header: "Name", value: (p) => p.name },
        { header: "Phone", value: (p) => p.phone },
        { header: "Works as", value: (p) => label(CATEGORY_LABEL, p.category) },
        { header: "Earned", value: (p) => p.earned },
        { header: "Paid", value: (p) => p.paid },
        { header: "Advances", value: (p) => p.advances },
        { header: "Expenses", value: (p) => p.expenses },
        { header: "Credits", value: (p) => p.credits },
        { header: "Received back", value: (p) => p.recovered },
        { header: "Balance", value: (p) => p.balance },
        {
          header: "Balance means",
          value: (p) => (Number(p.balance) > 0 ? "To pay" : Number(p.balance) < 0 ? "To receive" : "Settled"),
        },
        { header: "Last entry", value: (p) => p.lastDate },
        { header: "Status", value: (p) => (p.active ? "Active" : "Inactive") },
      ],
      people,
      (p) => p.id,
    );
  }) satisfies RequestHandler);

  router.get("/people/:id", view, (async (req, res) => {
    res.json({ success: true, data: await paymentsService.person(idOf(req)) });
  }) satisfies RequestHandler);

  router.get("/ledger", view, (async (req, res) => {
    res.json({ success: true, data: await paymentsService.ledger(ledgerQuery(req)) });
  }) satisfies RequestHandler);

  router.get("/ledger/export", view, (async (req, res) => {
    const query = ledgerQuery(req);
    const { entries } = await paymentsService.ledger(allRows(query));

    sendCsv(req, res, "ledger", ledgerColumns(!query.karigarId), entries, (e) => e.id);
  }) satisfies RequestHandler);

  router.post("/entries", manage, (async (req, res) => {
    const entry = await paymentsService.record(actorOf(req), entrySchema.parse(req.body), clientMeta(req));

    res.status(201).json({ success: true, data: { entry } });
  }) satisfies RequestHandler);

  router.post("/entries/:id/reverse", manage, (async (req, res) => {
    const { reason } = reverseSchema.parse(req.body);
    const entry = await paymentsService.reverse(actorOf(req), idOf(req), reason, clientMeta(req));

    res.json({ success: true, data: { entry } });
  }) satisfies RequestHandler);

  return router;
}
