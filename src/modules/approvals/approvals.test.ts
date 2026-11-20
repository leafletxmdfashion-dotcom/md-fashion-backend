import { beforeEach, describe, expect, it } from "vitest";

import { post, stitchedLot, today } from "../../test/fixtures";
import { createUser, loggedInClient, resetDatabase, sql, type TestClient } from "../../test/helpers";

beforeEach(resetDatabase);

const rules = (owner: TestClient, approveReversals: boolean, approveAdjustments: boolean) =>
  owner.send("put", "/api/v1/settings", {
    companyName: "MD Fashion Center",
    lotNumberPattern: "LOT-{seq}",
    approveReversals,
    approveAdjustments,
  });

async function setup() {
  const lot = await stitchedLot();

  await createUser({ email: "admin@garment.test", role: "ADMIN", name: "Asha Admin" });
  await createUser({ email: "admin2@garment.test", role: "ADMIN", name: "Bikash Admin" });

  const admin = await loggedInClient("admin@garment.test");
  const admin2 = await loggedInClient("admin2@garment.test");
  const payment = (
    await post(lot.owner, "/api/v1/payments/entries", {
      karigarId: lot.ram,
      type: "PAYMENT",
      amount: 100,
      entryDate: today,
    })
  ).entry as { id: string };

  return { ...lot, admin, admin2, paymentId: payment.id };
}

async function reversals(paymentId: string) {
  const { rows } = await sql(
    `SELECT count(*)::int AS n FROM karigar_ledger
     WHERE type = 'ENTRY_REVERSAL' AND source_id = (SELECT source_id FROM karigar_ledger WHERE id = $1)`,
    [paymentId],
  );

  return rows[0].n as number;
}

const reverse = (client: TestClient, paymentId: string, reason: string) =>
  client.send("post", `/api/v1/payments/entries/${paymentId}/reverse`, { reason });

describe("approvals", () => {
  it("acts at once while the rules are off", async () => {
    const { admin, paymentId } = await setup();

    expect((await reverse(admin, paymentId, "Paid twice")).status).toBe(200);
    expect(await reversals(paymentId)).toBe(1);
  });

  it("holds a reversal for approval, which someone else approves and the real reversal runs", async () => {
    const { owner, admin, admin2, paymentId } = await setup();

    await rules(owner, true, false);

    const held = await reverse(admin, paymentId, "Paid twice");

    expect(held.status, JSON.stringify(held.body)).toBe(202);
    expect(held.body.data.approval).toMatchObject({
      type: "PAYMENT_REVERSAL",
      status: "PENDING",
      reason: "Paid twice",
      change: "Rs 100.00 recorded → Reversed",
      requestedBy: { name: "Asha Admin" },
    });
    expect(await reversals(paymentId)).toBe(0);

    // One open request per record.
    expect((await reverse(admin2, paymentId, "Again")).status).toBe(409);

    const id = held.body.data.approval.id as string;

    // Not by the person who asked.
    expect((await admin.send("post", `/api/v1/approvals/${id}/approve`, {})).status).toBe(403);
    expect((await admin2.get("/api/v1/approvals/pending-count")).body.data.count).toBe(1);
    expect((await admin2.get("/api/v1/approvals/alerts")).body.data.items).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: "approvals", count: 1, href: "/approvals" })]),
    );

    const approved = await admin2.send("post", `/api/v1/approvals/${id}/approve`, { comment: "Checked the book" });

    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.data.request).toMatchObject({ status: "APPROVED", decidedBy: "Bikash Admin" });
    expect(await reversals(paymentId)).toBe(1);
    expect((await admin2.send("post", `/api/v1/approvals/${id}/approve`, {})).status).toBe(409);

    const events = await sql(
      "SELECT event_type FROM audit_events WHERE event_type LIKE 'APPROVAL_%' ORDER BY created_at",
    );

    expect(events.rows.map((row) => String(row.event_type))).toEqual(["APPROVAL_REQUESTED", "APPROVAL_APPROVED"]);
  });

  it("lets the Owner act directly, keeps a stale request open with the reason, then rejects it", async () => {
    const { owner, admin, admin2, paymentId } = await setup();

    await rules(owner, true, false);

    const held = await reverse(admin, paymentId, "Paid twice");
    const id = held.body.data.approval.id as string;

    // The Owner's own reversal never waits.
    expect((await reverse(owner, paymentId, "Owner")).status).toBe(200);
    expect((await admin2.send("post", `/api/v1/approvals/${id}/approve`, {})).status).toBe(409);

    const list = (await admin2.get("/api/v1/approvals?status=PENDING")).body.data;

    expect(list.requests[0]).toMatchObject({
      id,
      status: "PENDING",
      lastError: "This entry has already been reversed.",
    });
    expect((await admin2.send("post", `/api/v1/approvals/${id}/reject`, { comment: "x" })).status).toBe(400);

    const rejected = await admin2.send("post", `/api/v1/approvals/${id}/reject`, { comment: "Already done by owner" });

    expect(rejected.body.data.request).toMatchObject({ status: "REJECTED", comment: "Already done by owner" });
    expect(await reversals(paymentId)).toBe(1);
  });

  it("holds stock adjustments under their own rule, and lets the requester cancel", async () => {
    const { owner, admin, admin2, fabricId, paymentId } = await setup();
    const balance = async () =>
      Number((await sql("SELECT balance FROM fabric_stock WHERE fabric_id = $1", [fabricId])).rows[0].balance);
    const before = await balance();

    await rules(owner, false, true);

    const held = await admin.send("post", `/api/v1/fabrics/${fabricId}/adjustments`, {
      direction: "OUT",
      quantity: 2.5,
      reason: "Recount",
    });

    expect(held.status, JSON.stringify(held.body)).toBe(202);
    expect(held.body.data.approval.change).toMatch(/\(−2\.5 kg\)$/);

    const second = await admin.send("post", `/api/v1/fabrics/${fabricId}/adjustments`, {
      direction: "IN",
      quantity: 1,
      reason: "Found a roll",
    });
    const secondId = second.body.data.approval.id as string;

    // Someone else cannot cancel it; the requester can.
    expect((await admin2.send("post", `/api/v1/approvals/${secondId}/cancel`, {})).status).toBe(403);
    expect((await admin.send("post", `/api/v1/approvals/${secondId}/cancel`, {})).status).toBe(200);

    expect((await admin2.send("post", `/api/v1/approvals/${held.body.data.approval.id}/approve`, {})).status).toBe(200);
    expect(await balance()).toBeCloseTo(before - 2.5, 3);

    // Reversals stay immediate: only adjustments wait under this rule.
    expect((await reverse(admin, paymentId, "Paid twice")).status).toBe(200);
    expect((await admin.get("/api/v1/approvals")).body.data.counts).toMatchObject({
      PENDING: 0,
      APPROVED: 1,
      CANCELLED: 1,
    });
  });

  it("shows people without the approve right only their own requests", async () => {
    const { owner, admin, paymentId } = await setup();

    await rules(owner, true, false);
    await reverse(admin, paymentId, "Paid twice");
    await createUser({ email: "accounts@garment.test", role: "ACCOUNTANT" });

    const accounts = await loggedInClient("accounts@garment.test");

    expect((await accounts.get("/api/v1/approvals")).body.data).toMatchObject({ total: 0, canDecide: false });
    expect((await admin.get("/api/v1/approvals")).body.data).toMatchObject({ total: 1, canDecide: true });
  });
});
