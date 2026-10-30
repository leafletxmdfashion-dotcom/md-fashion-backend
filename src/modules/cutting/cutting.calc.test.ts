import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  calculateBatch,
  calculatedPalaKg,
  costOf,
  fabricCosts,
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

function colour(name: string, rolls: RollInput[]): ColourInput {
  return { name, rolls };
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

    expect(result.marker).toMatchObject({
      activePalaKg: 2_130_000n,
      measuredPalaKg: 2_200_000n,
      differenceKg: 70_000n,
    });
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
    const result = calculateBatch(marker("2.130", { repetitionsPerLayer: 2 }), [
      colour("Black", [roll("A", "30.500")]),
    ]);

    expect(result.colours[0]!.rolls[0]).toMatchObject({ estimatedPala: 14, estimatedLayers: 7, confirmedPala: 14 });
  });
});

describe("validation", () => {
  const issuesFor = (rolls: RollInput[], palaKg = "2.130") =>
    calculateBatch(marker(palaKg), [colour("Black", rolls)]).issues.map((issue) => issue.path);

  it("lets a Thaan be blank: the API numbers it", () => {
    expect(issuesFor([roll("", "3"), roll("", "3")])).toEqual([]);
  });

  it("blocks returns above the issued weight, zero issues and bad Pala weights", () => {
    expect(issuesFor([roll("A", "3", { returnedKg: "4" })])).toEqual(["colours.0.rolls.0.returnedKg"]);
    expect(issuesFor([roll("A", "0")])).toEqual(["colours.0.rolls.0.issuedKg"]);
    expect(issuesFor([roll("A", "3")], "0")).toContain("marker.measuredPalaKg");
  });

  it("blocks duplicate Thaan and fractional ratios", () => {
    const result = calculateBatch(
      marker("2.130", { sizes: [{ label: "S", piecesPerPala: 1.5, pieceWeightG: null }] }),
      [colour("Black", [roll("A", "3"), roll("a", "3")])],
    );

    expect(result.issues.map((issue) => issue.path)).toEqual(["sizes.0.piecesPerPala", "colours.0.rolls.1.thaan"]);
  });

  it("lets a size be left out of the marker with 0 pieces per Pala", () => {
    const sizes = [
      { label: "S", piecesPerPala: 3, pieceWeightG: null },
      { label: "M", piecesPerPala: 0, pieceWeightG: null },
      { label: "L", piecesPerPala: 0, pieceWeightG: null },
    ];

    const result = calculateBatch(marker("2.130", { sizes }), [colour("Black", [roll("A", "30.500")])]);

    expect(result.issues).toEqual([]);
    expect(result.marker.piecesPerPala).toBe(3);
    expect(result.colours[0]!.sizes.map((size) => size.accepted)).toEqual([42, 0, 0]);
    expect(result.totals).toMatchObject({ confirmedPala: 14, plannedPieces: 42, acceptedPieces: 42 });
  });

  it("needs at least one size with pieces, and no negative counts", () => {
    const zero = [
      { label: "S", piecesPerPala: 0, pieceWeightG: null },
      { label: "M", piecesPerPala: 0, pieceWeightG: null },
    ];

    expect(calculateBatch(marker("2.130", { sizes: zero }), [colour("Black", [roll("A", "3")])]).issues).toEqual([
      { path: "sizes", message: "At least one size needs pieces per Pala." },
    ]);

    const negative = [{ label: "S", piecesPerPala: -1, pieceWeightG: null }];

    expect(
      calculateBatch(marker("2.130", { sizes: negative }), [colour("Black", [roll("A", "3")])]).issues.map(
        (issue) => issue.path,
      ),
    ).toEqual(["sizes.0.piecesPerPala"]);
  });
});

describe("costing and earnings", () => {
  it("charges consumed and wasted fabric once each", () => {
    expect(costOf(29_820_000n, "500")).toBe(1_491_000n);
    expect(costOf(680_000n, "500.0000")).toBe(34_000n);
  });

  it("rounds a batch's fabric cost once, so consumed + wastage = total kg × rate to the paisa", () => {
    // Two Thaan at Rs 412.50: wastage 0.25 kg (103.125) and 0.75 kg (309.375) would round to 412.51 one by one.
    const costs = fabricCosts([
      { consumedKg: 10_000_000n, wastageKg: 250_000n, rate: "412.5000" },
      { consumedKg: 10_000_000n, wastageKg: 750_000n, rate: "412.5000" },
    ]);
    expect(costs).toEqual({ consumed: 825_000n, wastage: 41_250n });

    // Rates may differ per Thaan: consumed 100.80501 → 100.81, total 101.40499 → 101.40, so wastage takes 0.59.
    const mixed = fabricCosts([
      { consumedKg: 1_005_000n, wastageKg: 1_000n, rate: "100.0050" },
      { consumedKg: 3_000n, wastageKg: 5_000n, rate: "99.9950" },
    ]);
    expect(mixed).toEqual({ consumed: 10_081n, wastage: 59n });
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

describe("manual Pala and worked-out returns", () => {
  const thaanOf = (rollInput: RollInput) =>
    calculateBatch(marker("2.300"), [colour("Black", [rollInput])]).colours[0]!.rolls[0]!;

  it("accepts more Pala than the weight estimate, counting the whole Thaan as used", () => {
    // 10 kg Thaan, 2.3 kg Pala: 4 fit by weight, but the cutter laid 9 on thinner fabric.
    const result = calculateBatch(marker("2.300"), [
      colour("Black", [roll("A", "10", { returnedKg: null, confirmedLayers: 9 })]),
    ]);

    expect(result.issues).toEqual([]);
    expect(result.colours[0]!.rolls[0]).toMatchObject({
      estimatedPala: 4,
      confirmedPala: 9,
      pieces: 36,
      consumedKg: 10_000_000n,
      returnedKg: 0n,
      wastageKg: 0n,
    });
    expect(result.warnings.map((warning) => warning.path)).toEqual(["colours.0.rolls.0.confirmedLayers"]);
  });

  it("flags typed Pala that differ from the estimate either way, but not the estimate itself", () => {
    const warn = (layers: number | null) =>
      calculateBatch(marker("2.000"), [
        colour("Black", [roll("1", "20", { returnedKg: null, confirmedLayers: layers })]),
      ]).warnings.map((warning) => warning.message);

    expect(warn(11)).toEqual(["Black Thaan 1: 11 Pala entered, 10 fit by the marker weight."]);
    expect(warn(9)).toEqual(["Black Thaan 1: 9 Pala entered, 10 fit by the marker weight."]);
    expect(warn(10)).toEqual([]);
    expect(warn(null)).toEqual([]);
  });

  it("returns whole-Pala leftovers to the store and wastes the rest when no return is entered", () => {
    expect(thaanOf(roll("A", "10", { returnedKg: null }))).toMatchObject({
      confirmedPala: 4,
      consumedKg: 9_200_000n,
      returnedKg: 0n,
      wastageKg: 800_000n,
    });
    expect(thaanOf(roll("A", "10", { returnedKg: "", confirmedLayers: 3 }))).toMatchObject({
      consumedKg: 6_900_000n,
      returnedKg: 2_300_000n,
      wastageKg: 800_000n,
    });
  });

  it("uses an entered return as weighed", () => {
    expect(thaanOf(roll("A", "10", { returnedKg: "0.5" }))).toMatchObject({
      estimatedPala: 4,
      returnedKg: 500_000n,
      consumedKg: 9_200_000n,
      wastageKg: 300_000n,
    });
  });
});
