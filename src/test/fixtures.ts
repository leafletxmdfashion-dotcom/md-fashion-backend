import { expect } from "vitest";

import { createUser, loggedInClient, type TestClient } from "./helpers";

export const today = new Date().toISOString().slice(0, 10);

/** POST that must answer `status`; returns the response's data. */
// Supertest bodies are untyped; each caller narrows what it reads.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function post(client: TestClient, url: string, body: object, status = 201): Promise<any> {
  const res = await client.send("post", url, body);

  expect(res.status, JSON.stringify(res.body)).toBe(status);

  return res.body.data;
}

export async function karigar(
  owner: TestClient,
  name: string,
  category = "TAILOR",
  payRate = 0,
  extra: object = {},
): Promise<string> {
  // SAFETY: post() asserted the 201, so the karigar DTO is present.
  return (await post(owner, "/api/v1/karigars", { name, category, payMode: "PER_PIECE", payRate, ...extra })).karigar
    .id as string;
}

/**
 * A lot through cutting and stitching: LOT-1 "Polo", Black 30.5 kg + Blue 15 kg at 2.13 kg per Pala,
 * ratio S1 M2 L1 → S21 M42 L21 cut. All of it issued to Team Ram (Ram, Sita) and received:
 * S 20 Good + 1 reject, M 40 Good + 2 rework, L 21 Good.
 */
export async function stitchedLot(articleName = "Polo", lotNumber = "LOT-1") {
  await createUser({ email: "owner@garment.test", role: "OWNER", name: "Olivia Owner" });

  const owner = await loggedInClient("owner@garment.test");

  // SAFETY: post() asserted the 201, so the inward DTO is present.
  const fabricId = (
    await post(owner, "/api/v1/fabrics/inwards", {
      fabricName: "Jersey",
      unit: "KG",
      inwardDate: today,
      quantity: 100,
      rate: 500,
    })
  ).inward.fabric.id as string;

  const masterId = await karigar(owner, "Cutter", "CUTTING_MASTER");
  const ram = await karigar(owner, "Ram");
  const sita = await karigar(owner, "Sita");

  const lot = await cutLot(owner, fabricId, masterId, articleName, lotNumber);

  // SAFETY: post() asserted the 201, so the team DTO is present.
  const teamId = (
    await post(owner, "/api/v1/jogadi", { name: "Team Ram", members: [{ karigarId: ram }, { karigarId: sita }] })
  ).team.id as string;

  const stitched = await stitch(owner, lot.lotId, teamId);

  return { owner, fabricId, masterId, teamId, ram, sita, ...lot, ...stitched };
}

export async function cutLot(
  owner: TestClient,
  fabricId: string,
  masterId: string,
  articleName: string,
  lotNumber: string,
) {
  const created = await post(owner, "/api/v1/production-lots", {
    lotNumber,
    article: { name: articleName },
    fabricId,
    productionDate: today,
    targetQuantity: null,
    cutting: {
      cuttingMasterId: masterId,
      cuttingDate: today,
      marker: { measuredPalaKg: "2.130", weightSource: "MEASURED", repetitionsPerLayer: 1 },
      sizes: [
        { label: "S", piecesPerPala: 1 },
        { label: "M", piecesPerPala: 2 },
        { label: "L", piecesPerPala: 1 },
      ],
      colours: [
        { name: "Black", rolls: [{ issuedKg: "30.5" }] },
        { name: "Blue", rolls: [{ issuedKg: "15" }] },
      ],
    },
  });

  await post(owner, `/api/v1/cutting-batches/${created.batch.id}/finalize`, {});

  return { lotId: created.lot.id as string, articleId: created.lot.article.id as string };
}

/** Issues every cut piece of the lot to the team and receives it back (S 20+1 reject, M 40+2 rework, L 21). */
export async function stitch(owner: TestClient, lotId: string, teamId: string) {
  const issue = (
    await post(owner, "/api/v1/stitching/issues", {
      lotId,
      operation: "Full stitching",
      rate: 10,
      issueDate: today,
      teams: [
        {
          teamId,
          lines: [
            { sizeLabel: "S", quantity: 21 },
            { sizeLabel: "M", quantity: 42 },
            { sizeLabel: "L", quantity: 21 },
          ],
        },
      ],
    })
  ).issues[0] as { id: string; lines: { id: string; sizeLabel: string }[] };

  const line = (size: string) => issue.lines.find((item) => item.sizeLabel === size)!.id;

  const received = await post(owner, `/api/v1/stitching/issues/${issue.id}/receipts`, {
    receiptDate: today,
    lines: [
      { issueLineId: line("S"), good: 20, rework: 0, reject: 1, rejectReason: "Hole or tear" },
      { issueLineId: line("M"), good: 40, rework: 2, reject: 0 },
      { issueLineId: line("L"), good: 21, rework: 0, reject: 0 },
    ],
  });

  return { issueId: issue.id, receiptId: received.issue.receipts[0].id as string };
}
