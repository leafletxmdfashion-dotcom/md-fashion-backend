import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  calculateBatch,
  calculatedPalaKg,
  costOf,
  cuttingEarning,
  formatKg,
  type ColourInput,
  type MarkerInput,
  type RollInput,
} from "./cutting.calc";

const ratio121 = [
  { label: "S", piecesPerPala: 1, pieceWeightG: null },
  { label: "M", piecesPerPala: 2, pieceWeightG: null },
  { label: "L", piecesPerPala: 1, pieceWeightG: null },
];

function marker(palaKg: string, overrides: Partial<MarkerInput> = {}): MarkerInput {
  return {
    widthM: null,
    lengthM: null,
    gsm: null,
    measuredPalaKg: palaKg,
    weightSource: "MEASURED",
    repetitionsPerLayer: 1,
    sizes: ratio121,
    ...overrides,
  };
}

function roll(thaan: string, issuedKg: string, extra: Partial<RollInput> = {}): RollInput {
  return { thaan, issuedKg, returnedKg: "0", confirmedLayers: null, ...extra };
}

function colour(name: string, rolls: RollInput[], rejects: ColourInput["rejects"] = []): ColourInput {
  return { name, rolls, rejects };
}

const kg = (micro: bigint) => formatKg(micro);

describe("cutting calculation (V1 acceptance scenarios)", () => {
  it("1: standard Pala from a 30.500 kg Thaan", () => {
    const result = calculateBatch(marker("2.130"), [colour("Black", [roll("TH-001", "30.500")])]);
    const [black] = result.colours;
    const [thaan] = black!.rolls;

    expect(result.issues).toEqual([]);
    expect(thaan).toMatchObject({ estimatedPala: 14, confirmedPala: 14, pieces: 56 });
    expect(kg(thaan!.consumedKg)).toBe("29.820");
    expect(kg(thaan!.wastageKg)).toBe("0.680");
    expect(black!.sizes.map((size) => [size.label, size.planned])).toEqual([
      ["S", 14],
      ["M", 28],
      ["L", 14],
    ]);
    expect(result.totals.acceptedPieces).toBe(56);
  });

  it("2: exact division leaves no wastage", () => {
    const [thaan] = calculateBatch(marker("2.130"), [colour("Black", [roll("A", "21.300")])]).colours[0]!.rolls;

    expect(thaan).toMatchObject({ estimatedPala: 10, wastageKg: 0n });
    expect(kg(thaan!.consumedKg)).toBe("21.300");
  });

  it("3: less than one Pala makes the whole roll wastage, with a warning", () => {
    const result = calculateBatch(marker("2.130"), [colour("Black", [roll("A", "1.500")])]);
    const [thaan] = result.colours[0]!.rolls;

    expect(thaan).toMatchObject({ estimatedPala: 0, pieces: 0 });
    expect(kg(thaan!.wastageKg)).toBe("1.500");
    expect(result.issues).toEqual([]);
    expect(result.warnings[0]?.message).toMatch(/whole|all 1\.500 kg/);
  });

  it("4: returned fabric is not wastage", () => {
    const [thaan] = calculateBatch(marker("2.130"), [
      colour("Black", [roll("A", "30.500", { returnedKg: "0.500", confirmedLayers: 14 })]),
    ]).colours[0]!.rolls;

    expect(kg(thaan!.consumedKg)).toBe("29.820");
    expect(kg(thaan!.wastageKg)).toBe("0.180");
    expect(kg(thaan!.returnedKg)).toBe("0.500");
  });

  it("5: fewer confirmed Pala leave more wastage", () => {
    const result = calculateBatch(marker("2.130"), [colour("Black", [roll("A", "30.500", { confirmedLayers: 13 })])]);
    const [thaan] = result.colours[0]!.rolls;

    expect(kg(thaan!.consumedKg)).toBe("27.690");
    expect(kg(thaan!.wastageKg)).toBe("2.810");
    expect(result.totals.plannedPieces).toBe(52);
  });

  it("6: remainders of separate rolls are never pooled", () => {
    const result = calculateBatch(marker("2.130"), [colour("Black", [roll("A", "1.500"), roll("B", "1.500")])]);

    expect(result.colours[0]!.rolls.map((r) => r.estimatedPala)).toEqual([0, 0]);
    expect(result.totals.confirmedPala).toBe(0);
  });

  it("7: colours keep their own size output; lot totals add up", () => {
    const result = calculateBatch(marker("2.130"), [
      colour("Black", [roll("TH-001", "30.500")]),
      colour("Blue", [roll("TH-002", "15.000")]),
    ]);

    const [black, blue] = result.colours;

    expect(black!.totals.acceptedPieces).toBe(56);
    expect(blue!.totals).toMatchObject({ confirmedPala: 7, acceptedPieces: 28 });
    expect(kg(blue!.totals.wastageKg)).toBe("0.090");
    expect(blue!.sizes.map((size) => size.planned)).toEqual([7, 14, 7]);
    expect(result.totals.acceptedPieces).toBe(84);
  });

  it("8: changing the ratio recomputes sizes, not the Pala", () => {
    const rolls = [colour("Black", [roll("A", "30.500")])];
    const before = calculateBatch(marker("2.130"), rolls);

    const after = calculateBatch(
      marker("2.130", {
        sizes: [
          { label: "S", piecesPerPala: 1, pieceWeightG: null },
          { label: "M", piecesPerPala: 1, pieceWeightG: null },
          { label: "L", piecesPerPala: 2, pieceWeightG: null },
        ],
      }),
      rolls,
    );

    expect(after.totals.acceptedPieces).toBe(before.totals.acceptedPieces);
    expect(after.colours[0]!.sizes.map((size) => size.planned)).toEqual([14, 14, 28]);
  });

  it("12: weights beyond three decimals stay exact and always reconcile", () => {
    const result = calculateBatch(marker("2.1305"), [colour("Black", [roll("A", "30.500", { returnedKg: "0.25" })])]);
    const [thaan] = result.colours[0]!.rolls;

    expect(thaan!.estimatedPala).toBe(14);
    expect(thaan!.consumedKg).toBe(29_827_000n);
    expect(thaan!.wastageKg).toBe(423_000n);
    expect(thaan!.consumedKg + thaan!.wastageKg + thaan!.returnedKg).toBe(thaan!.issuedKg);

    const thirds = calculateBatch(marker("0.333333"), [colour("Black", [roll("A", "1")])]).colours[0]!.rolls[0]!;

    expect(thirds).toMatchObject({ estimatedPala: 3, consumedKg: 999_999n, wastageKg: 1n });
  });
});

describe("marker", () => {
  it("calculates Pala weight from width × length × GSM and shows the difference to the measured one", () => {
    expect(calculatedPalaKg("1.50", "7.10", "200")).toBe(2_130_000n);

    const result = calculateBatch(
      marker("2.200", { widthM: "1.5", lengthM: "7.1", gsm: "200", weightSource: "CALCULATED" }),
      [colour("Black", [roll("A", "30.5")])],
    );

    expect(result.marker).toMatchObject({ activePalaKg: 2_130_000n, measuredPalaKg: 2_200_000n, differenceKg: 70_000n });
  });

  it("never lets the calculated weight replace a measured one", () => {
    const result = calculateBatch(marker("2.200", { widthM: "1.5", lengthM: "7.1", gsm: "200" }), []);

    expect(result.marker.activePalaKg).toBe(2_200_000n);
  });

  it("estimates internal scrap from size weights without touching consumption", () => {
    const sizes = [
      { label: "S", piecesPerPala: 1, pieceWeightG: "350" },
      { label: "M", piecesPerPala: 2, pieceWeightG: "450" },
      { label: "L", piecesPerPala: 1, pieceWeightG: "500" },
    ];

    const result = calculateBatch(marker("2.130", { sizes }), [colour("Black", [roll("A", "30.500")])]);

    expect(kg(result.marker.netPalaKg!)).toBe("1.750");
    expect(kg(result.marker.scrapPerPalaKg!)).toBe("0.380");
    expect(kg(result.totals.consumedKg)).toBe("29.820");
  });

  it("rejects size weights heavier than the Pala", () => {
    const sizes = [{ label: "S", piecesPerPala: 4, pieceWeightG: "600" }];
    const result = calculateBatch(marker("2.130", { sizes }), []);

    expect(result.issues).toContainEqual(expect.objectContaining({ path: "sizes" }));
  });

  it("counts Pala as layers × marker repetitions", () => {
    const result = calculateBatch(marker("2.130", { repetitionsPerLayer: 2 }), [colour("Black", [roll("A", "30.500")])]);

    expect(result.colours[0]!.rolls[0]).toMatchObject({ estimatedPala: 14, estimatedLayers: 7, confirmedPala: 14 });
  });
});

describe("validation", () => {
  const issuesFor = (rolls: RollInput[], palaKg = "2.130") =>
    calculateBatch(marker(palaKg), [colour("Black", rolls)]).issues.map((issue) => issue.path);

  it("blocks more confirmed Pala than the roll can give", () => {
    expect(issuesFor([roll("A", "30.500", { confirmedLayers: 15 })])).toEqual(["colours.0.rolls.0.confirmedLayers"]);
  });

  it("blocks returns above the issued weight, zero issues and bad Pala weights", () => {
    expect(issuesFor([roll("A", "3", { returnedKg: "4" })])).toEqual(["colours.0.rolls.0.returnedKg"]);
    expect(issuesFor([roll("A", "0")])).toEqual(["colours.0.rolls.0.issuedKg"]);
    expect(issuesFor([roll("A", "3")], "0")).toContain("marker.measuredPalaKg");
  });

  it("blocks duplicate Thaan, fractional ratios and rejects beyond the cut", () => {
    const result = calculateBatch(
      marker("2.130", { sizes: [{ label: "S", piecesPerPala: 1.5, pieceWeightG: null }] }),
      [colour("Black", [roll("A", "3"), roll("a", "3")], [{ sizeLabel: "XL", quantity: 1, reason: "Torn" }])],
    );

    expect(result.issues.map((issue) => issue.path)).toEqual([
      "sizes.0.piecesPerPala",
      "colours.0.rolls.1.thaan",
      "colours.0.rejects.0.sizeLabel",
    ]);
  });

  it("subtracts rejected pieces from the accepted output", () => {
    const result = calculateBatch(marker("2.130"), [
      colour("Black", [roll("A", "30.500")], [{ sizeLabel: "m", quantity: 1, reason: "Damaged" }]),
    ]);

    expect(result.colours[0]!.sizes[1]).toMatchObject({ planned: 28, rejected: 1, accepted: 27 });
    expect(result.totals).toMatchObject({ plannedPieces: 56, acceptedPieces: 55 });

    const tooMany = calculateBatch(marker("2.130"), [
      colour("Black", [roll("A", "3")], [{ sizeLabel: "M", quantity: 3, reason: "Damaged" }]),
    ]);

    expect(tooMany.issues.map((issue) => issue.path)).toEqual(["colours.0.rejects.0.quantity"]);
  });
});

describe("costing and earnings", () => {
  it("charges consumed and wasted fabric once each", () => {
    expect(costOf(29_820_000n, "500")).toBe(1_491_000n);
    expect(costOf(680_000n, "500.0000")).toBe(34_000n);
  });

  it("pays by the cutting master's mode", () => {
    const work = calculateBatch(marker("2.130"), [colour("Black", [roll("A", "30.500")])]).totals;

    expect(cuttingEarning("PER_PIECE", "2.50", work)).toEqual({ quantity: 56_000_000n, amount: 14_000n });
    expect(cuttingEarning("PER_PALA", "10", work)?.amount).toBe(14_000n);
    expect(cuttingEarning("PER_KG", "10", work)?.amount).toBe(29_820n);
    expect(cuttingEarning("FIXED_JOB", "500", work)?.amount).toBe(50_000n);
    expect(cuttingEarning("SALARY", "0", work)).toBeNull();
  });
});

describe("frontend copy", () => {
  const copy = path.resolve(__dirname, "../../../../md_frontend/features/production/lib/cutting-calc.ts");

  it.runIf(existsSync(copy))("matches this file exactly", () => {
    expect(readFileSync(copy, "utf8")).toBe(readFileSync(path.resolve(__dirname, "cutting.calc.ts"), "utf8"));
  });
});
