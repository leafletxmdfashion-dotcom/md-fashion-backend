import type { Request, Response } from "express";
import { beforeEach, describe, expect, it } from "vitest";

import { BOM, EXPORT_MAX, sendCsv } from "../lib/csv-export";
import { AppError } from "../lib/errors";
import { karigar, post, stitchedLot, today } from "../test/fixtures";
import { createUser, loggedInClient, resetDatabase, TestClient } from "../test/helpers";

// Every list's Export: built on the server from the same query as the list, every matching
// row (not one page), the user's selection, and the same money and access rules.

beforeEach(resetDatabase);

/** RFC 4180 parse (quotes, doubled quotes, CRLF), enough for these files. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += char;
  }
  row.push(cell);
  rows.push(row);
  return rows;
}

async function exportCsv(client: TestClient, url: string) {
  const res = await client.get(url);
  expect(res.status, `${url}: ${res.text.slice(0, 300)}`).toBe(200);
  expect(res.headers["content-type"]).toMatch(/^text\/csv/);
  expect(res.headers["content-disposition"]).toMatch(/^attachment; filename="[\w-]+-\d{4}-\d{2}-\d{2}\.csv"$/);
  expect(res.headers["cache-control"]).toBe("no-store");
  expect(res.text.startsWith(BOM)).toBe(true);
  const [header, ...rows] = parseCsv(res.text.slice(1));
  // A file with only the header has no data rows.
  const data = rows.length === 1 && rows[0]!.length === 1 && rows[0]![0] === "" ? [] : rows;
  expect(Number(res.headers["x-export-rows"])).toBe(data.length);
  return { header: header!, rows: data, res };
}

/** A lot through cutting, stitching, packing and dispatch, plus payments, for every list to have rows. */
async function everything() {
  const lot = await stitchedLot();
  const { owner, lotId, articleId, ram } = lot;
  const packer = await karigar(owner, "Puja", "PACKER", 1.5);
  await post(owner, "/api/v1/packing/entries", {
    lotId,
    packerId: packer,
    packDate: today,
    lines: [
      { sizeLabel: "S", quantity: 20 },
      { sizeLabel: "M", quantity: 30 },
    ],
  });
  await post(owner, "/api/v1/godown/dispatches", {
    dispatchDate: today,
    party: "City Mart",
    challan: "CH-1",
    lines: [{ articleId, sizeLabel: "M", quantity: 5 }],
  });
  // More ledger rows than one page holds (25), so a page-sized export would be short.
  for (let i = 0; i < 30; i++) {
    await post(owner, "/api/v1/payments/entries", {
      karigarId: ram,
      type: "EXPENSE",
      amount: 10 + i,
      entryDate: today,
      category: "Food",
    });
  }
  return { ...lot, packer };
}

// [list URL, export URL, rows key in the list response]
const LISTS: [string, string, string][] = [
  ["/api/v1/fabrics/movements", "/api/v1/fabrics/movements/export", "movements"],
  ["/api/v1/fabrics/inwards", "/api/v1/fabrics/inwards/export", "inwards"],
  ["/api/v1/cutting-batches", "/api/v1/cutting-batches/export", "batches"],
  ["/api/v1/stitching/issues", "/api/v1/stitching/issues/export", "issues"],
  ["/api/v1/stitching/rework", "/api/v1/stitching/rework/export", "items"],
  ["/api/v1/stitching/rejects", "/api/v1/stitching/rejects/export", "rejects"],
  ["/api/v1/karigars", "/api/v1/karigars/export", "karigars"],
  ["/api/v1/packing/queue?page=1", "/api/v1/packing/queue/export", "lots"],
  ["/api/v1/packing/entries", "/api/v1/packing/entries/export", "entries"],
  ["/api/v1/packing/lines", "/api/v1/packing/lines/export", "lines"],
  ["/api/v1/packing/staff?page=1", "/api/v1/packing/staff/export", "staff"],
  ["/api/v1/godown/stock?page=1", "/api/v1/godown/stock/export", "items"],
  ["/api/v1/godown/movements", "/api/v1/godown/movements/export", "movements"],
  ["/api/v1/godown/dispatches", "/api/v1/godown/dispatches/export", "dispatches"],
  ["/api/v1/godown/finished-goods", "/api/v1/godown/finished-goods/export", "lots"],
  ["/api/v1/godown/finished-goods/items?page=1", "/api/v1/godown/finished-goods/items/export", "items"],
  ["/api/v1/payments/people", "/api/v1/payments/people/export", "people"],
  ["/api/v1/payments/ledger", "/api/v1/payments/ledger/export", "entries"],
  ["/api/v1/users?page=1", "/api/v1/users/export", "users"],
];

describe("exports", () => {
  it("every list exports exactly the rows it matches, all of them, as CSV from the server", async () => {
    const { owner } = await everything();

    for (const [listUrl, exportUrl, key] of LISTS) {
      const list = await owner.get(listUrl);
      expect(list.status, listUrl).toBe(200);
      const total = list.body.data.total as number;
      expect(total, listUrl).toBeGreaterThan(0);

      const { header, rows } = await exportCsv(owner, exportUrl);
      expect(rows, exportUrl).toHaveLength(total);
      expect(header.length, exportUrl).toBeGreaterThan(2);
      expect(
        rows.every((row) => row.length === header.length),
        exportUrl,
      ).toBe(true);
      // The list page holds at most its page size; the export holds every match.
      expect((list.body.data[key] as unknown[]).length).toBeLessThanOrEqual(total);
    }

    // 30 expenses + earnings: more than the 25 rows of one page.
    const ledger = await exportCsv(owner, "/api/v1/payments/ledger/export");
    expect(ledger.rows.length).toBeGreaterThan(30);
    expect((await owner.get("/api/v1/payments/ledger")).body.data.entries).toHaveLength(25);
  });

  it("applies the list's search, column filters and sort", async () => {
    const { owner, ram } = await everything();

    const food = await exportCsv(owner, `/api/v1/payments/ledger/export?karigarId=${ram}&amountMin=-15&amountMax=-10`);
    expect(food.header).not.toContain("Person"); // one person's ledger
    expect(food.rows.map((row) => row[food.header.indexOf("Out (−)")]).sort()).toEqual([
      "10.00",
      "11.00",
      "12.00",
      "13.00",
      "14.00",
      "15.00",
    ]);

    const sizes = await exportCsv(owner, "/api/v1/godown/stock/export?sizes=M");
    expect(sizes.rows).toHaveLength(1);
    // The item row (all sizes) is kept when one of its sizes matches: S 20 + M 25.
    expect(sizes.rows[0]![sizes.header.indexOf("In stock")]).toBe("45");
    expect(sizes.rows[0]![sizes.header.indexOf("In stock by size")]).toBe("S 20, M 25");
    expect((await exportCsv(owner, "/api/v1/godown/stock/export?sizes=XXL")).rows).toHaveLength(0);

    expect((await exportCsv(owner, "/api/v1/packing/queue/export?waitingMin=1000")).rows).toHaveLength(0);

    const sorted = await exportCsv(owner, "/api/v1/karigars/export?sort=name&dir=desc");
    const names = sorted.rows.map((row) => row[sorted.header.indexOf("Name")]!);
    expect(names).toEqual([...names].sort((a, b) => b.localeCompare(a)));

    const search = await exportCsv(owner, "/api/v1/karigars/export?search=sita");
    expect(search.rows.map((row) => row[search.header.indexOf("Name")])).toEqual(["Sita"]);
  });

  it("exports only the selected rows when ids are given", async () => {
    const { owner, ram, sita } = await everything();

    const { rows, header, res } = await exportCsv(owner, `/api/v1/payments/people/export?ids=${ram},${sita}`);
    expect(res.headers["content-disposition"]).toMatch(/balances-selected-/);
    expect(rows.map((row) => row[header.indexOf("Name")]).sort()).toEqual(["Ram", "Sita"]);

    expect((await owner.get("/api/v1/payments/people/export?ids=not-a-uuid")).status).toBe(400);
  });

  it("leaves out money for people who may not see it", async () => {
    await everything();
    await createUser({ email: "packer@garment.test", role: "PACKING_STAFF" });
    const packer = await loggedInClient("packer@garment.test");

    const entries = await exportCsv(packer, "/api/v1/packing/entries/export");
    expect(entries.header).not.toContain("Pay");
    expect(entries.header).not.toContain("Rate per piece");
    expect(entries.rows.length).toBe(1);
    const staff = await exportCsv(packer, "/api/v1/packing/staff/export");
    expect(staff.header).not.toContain("Pay earned");
    // A filter on hidden pay is dropped, so it cannot reveal values by elimination.
    expect((await exportCsv(packer, "/api/v1/packing/staff/export?earnedMin=999999")).rows).toEqual(staff.rows);
  });

  it("needs the list's permission, and a person's own ledger stays their own", async () => {
    const { owner, ram, sita } = await everything();
    const userId = await createUser({ email: "ram@garment.test", role: "KARIGAR" });
    const linked = await owner.send("put", `/api/v1/karigars/${ram}`, {
      name: "Ram",
      category: "TAILOR",
      payMode: "PER_PIECE",
      payRate: 0,
      userId,
    });
    expect(linked.status).toBe(200);
    const me = await loggedInClient("ram@garment.test");

    for (const [, exportUrl] of LISTS) expect((await me.get(exportUrl)).status, exportUrl).toBe(403);

    const own = await exportCsv(me, `/api/v1/payments/me/ledger/export?karigarId=${sita}`);
    expect(own.header).not.toContain("Person");
    // Ram's earning and 30 expenses; asking for Sita is ignored.
    expect(own.rows.length).toBe(31);
    expect((await new TestClient().get("/api/v1/karigars/export")).status).toBe(401);
  });

  it("neutralises spreadsheet formulas in exported text", async () => {
    const { owner } = await everything();
    await karigar(owner, '=HYPERLINK("http://x")');

    const { rows, header } = await exportCsv(owner, "/api/v1/karigars/export?search=hyperlink");
    expect(rows[0]![header.indexOf("Name")]).toBe('\'=HYPERLINK("http://x")');
  });
});

describe("sendCsv", () => {
  it("refuses more rows than an export may hold instead of cutting the file short", () => {
    const rows = Array.from({ length: EXPORT_MAX + 1 }, (_, index) => ({ id: String(index) }));
    const res = { setHeader: () => res, send: () => res } as unknown as Response;
    const req = { query: {} } as unknown as Request;

    expect(() => sendCsv(req, res, "x", [{ header: "Id", value: (row) => row.id }], rows, (row) => row.id)).toThrow(
      AppError,
    );
  });
});
