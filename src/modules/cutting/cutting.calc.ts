// Weight-based cutting calculation, V1. Pure and exact: weights are BigInt
// micro-kilograms (1 kg = 1_000_000), money is BigInt paisa, so no binary
// floating point ever touches a quantity. Rounding happens only where a value
// is posted or shown, and is always half up.
//
// md_frontend/features/production/lib/cutting-calc.ts is an identical copy for the
// live preview; cutting.calc.test.ts fails if the two drift apart. The backend
// recalculates everything itself before posting and never trusts client totals.

export const CALCULATION_VERSION = 1;

export const WASTAGE_TYPE = "AUTO_PALA_REMAINDER";

const KG = 1_000_000n;

export type WeightSource = "MEASURED" | "CALCULATED";

export type PayMode = "PER_PIECE" | "PER_PALA" | "PER_KG" | "FIXED_JOB" | "SALARY";

export interface Issue {
  /** Dotted field path, e.g. "colours.0.rolls.1.returnedKg". */
  path: string;
  message: string;
}

export interface SizeInput {
  label: string;
  piecesPerPala: number;
  /** Grams per piece, optional. */
  pieceWeightG: string | null;
}

export interface MarkerInput {
  widthM: string | null;
  lengthM: string | null;
  gsm: string | null;
  measuredPalaKg: string | null;
  weightSource: WeightSource;
  repetitionsPerLayer: number;
  sizes: SizeInput[];
}

export interface RollInput {
  thaan: string;
  issuedKg: string;
  returnedKg: string;
  /** Null means "accept the estimate". Pala = layers × repetitions per layer. */
  confirmedLayers: number | null;
}

export interface ColourInput {
  name: string;
  rolls: RollInput[];
}

export interface MarkerResult {
  calculatedPalaKg: bigint | null;
  measuredPalaKg: bigint | null;
  activePalaKg: bigint | null;
  /** Measured minus calculated, when both exist. */
  differenceKg: bigint | null;
  piecesPerPala: number;
  /** Garment weight per Pala; null unless every size has a piece weight. */
  netPalaKg: bigint | null;
  /** Analytical estimate only. Never deducted from consumption. */
  scrapPerPalaKg: bigint | null;
}

export interface RollResult {
  issuedKg: bigint;
  returnedKg: bigint;
  /** Issued minus returned: what the cutting floor actually used. */
  netKg: bigint;
  estimatedPala: number;
  estimatedLayers: number;
  confirmedLayers: number;
  confirmedPala: number;
  consumedKg: bigint;
  wastageKg: bigint;
  pieces: number;
}

export interface SizeOutput {
  label: string;
  planned: number;
  accepted: number;
}

export interface Totals {
  issuedKg: bigint;
  returnedKg: bigint;
  consumedKg: bigint;
  wastageKg: bigint;
  estimatedPala: number;
  confirmedPala: number;
  plannedPieces: number;
  acceptedPieces: number;
}

export interface ColourResult {
  name: string;
  rolls: RollResult[];
  totals: Totals;
  sizes: SizeOutput[];
}

export interface BatchResult {
  marker: MarkerResult;
  colours: ColourResult[];
  totals: Totals;
  /** Blocking problems, keyed by field path. */
  issues: Issue[];
  /** Allowed, but worth confirming (e.g. a whole roll becoming wastage). */
  warnings: Issue[];
}

/** "30.5" → 305n at 1 place. Null unless a plain non-negative decimal with at most `places` decimals. */
export function parseScaled(text: string, places: number): bigint | null {
  const match = /^(\d{1,12})(?:\.(\d+))?$/.exec(text.trim());

  if (!match) return null;

  const fraction = match[2] ?? "";

  if (fraction.length > places) return null;

  return BigInt(`${match[1]}${fraction.padEnd(places, "0")}`);
}

export function parseKg(text: string): bigint | null {
  return parseScaled(text, 6);
}

/** Non-negative division rounded half up. */
function divideRounded(numerator: bigint, denominator: bigint): bigint {
  return (numerator * 2n + denominator) / (denominator * 2n);
}

/** Scaled integer → decimal string with exactly `places` decimals. Exact, no rounding. */
export function toDecimal(value: bigint, places: number): string {
  const sign = value < 0n ? "-" : "";
  const digits = (value < 0n ? -value : value).toString().padStart(places + 1, "0");
  const whole = digits.slice(0, digits.length - places);

  return places === 0 ? `${sign}${whole}` : `${sign}${whole}.${digits.slice(digits.length - places)}`;
}

/** Micro-kilograms → kilograms with `shown` decimals, rounded half up. For display and reports. */
export function formatKg(micro: bigint, shown = 3): string {
  const factor = 10n ** BigInt(6 - shown);
  const magnitude = divideRounded(micro < 0n ? -micro : micro, factor);

  return toDecimal(micro < 0n ? -magnitude : magnitude, shown);
}

/** Pala weight from fabric width (m) × marker length (m) × GSM ÷ 1000, in micro-kg. */
export function calculatedPalaKg(widthM: string | null, lengthM: string | null, gsm: string | null): bigint | null {
  const width = widthM === null ? null : parseScaled(widthM, 4);
  const length = lengthM === null ? null : parseScaled(lengthM, 4);
  const grams = gsm === null ? null : parseScaled(gsm, 2);

  if (!width || !length || !grams) return null;

  // 4 + 4 + 2 decimals = 10; grams → kg adds 3 more; micro-kg keeps 6, so drop 7.
  return divideRounded(width * length * grams, 10n ** 7n);
}

function calculateMarker(input: MarkerInput, issues: Issue[]): MarkerResult {
  const calculated = calculatedPalaKg(input.widthM, input.lengthM, input.gsm);
  const measured = input.measuredPalaKg ? parseKg(input.measuredPalaKg) : null;

  if (input.measuredPalaKg && (measured === null || measured === 0n)) {
    issues.push({ path: "marker.measuredPalaKg", message: "Enter the Pala weight in kg, up to 6 decimals." });
  }

  const active = input.weightSource === "MEASURED" ? measured || null : calculated;

  if (active === null) {
    issues.push(
      input.weightSource === "MEASURED"
        ? { path: "marker.measuredPalaKg", message: "Enter the measured weight of one Pala." }
        : { path: "marker.gsm", message: "Enter width, marker length and GSM to calculate the Pala weight." },
    );
  }

  if (!Number.isInteger(input.repetitionsPerLayer) || input.repetitionsPerLayer < 1 || input.repetitionsPerLayer > 50) {
    issues.push({ path: "marker.repetitionsPerLayer", message: "Use a whole number from 1 to 50." });
  }

  if (input.sizes.length === 0) issues.push({ path: "sizes", message: "Add at least one size." });

  const seen = new Set<string>();
  let piecesPerPala = 0;
  let netPalaKg: bigint | null = 0n;

  for (const [index, size] of input.sizes.entries()) {
    const label = size.label.trim();
    const key = label.toLowerCase();

    if (!label) issues.push({ path: `sizes.${index}.label`, message: "Enter the size." });
    else if (seen.has(key)) issues.push({ path: `sizes.${index}.label`, message: `${label} is listed twice.` });

    seen.add(key);

    // Zero is allowed: a marker may leave some sizes out entirely.
    if (!Number.isInteger(size.piecesPerPala) || size.piecesPerPala < 0 || size.piecesPerPala > 999) {
      issues.push({ path: `sizes.${index}.piecesPerPala`, message: "Use a whole number from 0 to 999." });
    } else {
      piecesPerPala += size.piecesPerPala;
    }

    // Grams with 3 decimals are milligrams, which are micro-kilograms.
    const weight = size.pieceWeightG ? parseScaled(size.pieceWeightG, 3) : null;

    if (size.pieceWeightG && !weight) {
      issues.push({ path: `sizes.${index}.pieceWeightG`, message: "Enter grams, up to 3 decimals." });
    }

    const count = Number.isInteger(size.piecesPerPala) ? BigInt(size.piecesPerPala) : 0n;

    netPalaKg = weight && netPalaKg !== null ? netPalaKg + weight * count : null;
  }

  if (input.sizes.length > 0 && input.sizes.every((size) => size.piecesPerPala === 0)) {
    issues.push({ path: "sizes", message: "At least one size needs pieces per Pala." });
  }

  if (input.sizes.length === 0) netPalaKg = null;

  if (netPalaKg !== null && active !== null && netPalaKg > active) {
    issues.push({
      path: "sizes",
      message: `Size weights add up to ${formatKg(netPalaKg)} kg per Pala, more than the Pala weight of ${formatKg(active)} kg.`,
    });
  }

  return {
    calculatedPalaKg: calculated,
    measuredPalaKg: measured || null,
    activePalaKg: active,
    differenceKg: measured && calculated ? measured - calculated : null,
    piecesPerPala,
    netPalaKg,
    scrapPerPalaKg: netPalaKg !== null && active !== null && netPalaKg <= active ? active - netPalaKg : null,
  };
}

/** One roll: whole Pala only, never rounded up; the unreturned remainder is wastage. */
export function calculateRoll(
  roll: RollInput,
  marker: MarkerResult,
  repetitionsPerLayer: number,
  path: string,
  issues: Issue[],
): RollResult {
  const issued = parseScaled(roll.issuedKg, 6);
  const returned = roll.returnedKg.trim() === "" ? 0n : parseScaled(roll.returnedKg, 6);

  if (issued === null) issues.push({ path: `${path}.issuedKg`, message: "Enter the issued weight in kg." });
  else if (issued === 0n) issues.push({ path: `${path}.issuedKg`, message: "Issued weight must be more than zero." });

  if (returned === null) issues.push({ path: `${path}.returnedKg`, message: "Enter the returned weight in kg." });

  const issuedKg = issued ?? 0n;
  let returnedKg = returned ?? 0n;

  if (returnedKg > issuedKg) {
    issues.push({ path: `${path}.returnedKg`, message: "Returned weight cannot be more than the issued weight." });
    returnedKg = issuedKg;
  }

  const netKg = issuedKg - returnedKg;
  const pala = marker.activePalaKg ?? 0n;
  const repetitions = Math.max(1, repetitionsPerLayer || 1);
  const estimatedPala = pala > 0n ? Number(netKg / pala) : 0;
  const estimatedLayers = Math.floor(estimatedPala / repetitions);
  let confirmedLayers = roll.confirmedLayers ?? estimatedLayers;

  if (!Number.isInteger(confirmedLayers) || confirmedLayers < 0) {
    issues.push({ path: `${path}.confirmedLayers`, message: "Use a whole number of zero or more." });
    confirmedLayers = 0;
  }

  let confirmedPala = confirmedLayers * repetitions;

  if (confirmedPala > estimatedPala) {
    issues.push({
      path: `${path}.confirmedLayers`,
      message: `${confirmedPala} Pala is more than this Thaan can give (${estimatedPala}). Re-measure the Pala weight first.`,
    });
    confirmedPala = estimatedPala;
  }

  const consumedKg = BigInt(confirmedPala) * pala;

  return {
    issuedKg,
    returnedKg,
    netKg,
    estimatedPala,
    estimatedLayers,
    confirmedLayers,
    confirmedPala,
    consumedKg,
    wastageKg: netKg - consumedKg,
    pieces: confirmedPala * marker.piecesPerPala,
  };
}

function emptyTotals(): Totals {
  return {
    issuedKg: 0n,
    returnedKg: 0n,
    consumedKg: 0n,
    wastageKg: 0n,
    estimatedPala: 0,
    confirmedPala: 0,
    plannedPieces: 0,
    acceptedPieces: 0,
  };
}

function addTotals(into: Totals, add: Totals): void {
  into.issuedKg += add.issuedKg;
  into.returnedKg += add.returnedKg;
  into.consumedKg += add.consumedKg;
  into.wastageKg += add.wastageKg;
  into.estimatedPala += add.estimatedPala;
  into.confirmedPala += add.confirmedPala;
  into.plannedPieces += add.plannedPieces;
  into.acceptedPieces += add.acceptedPieces;
}

/**
 * The whole batch: each roll on its own (remainders are never pooled across
 * rolls), then per colour, size-wise output = colour Pala × size ratio.
 */
export function calculateBatch(markerInput: MarkerInput, colourInputs: ColourInput[]): BatchResult {
  const issues: Issue[] = [];
  const warnings: Issue[] = [];
  const marker = calculateMarker(markerInput, issues);
  const totals = emptyTotals();
  const colourNames = new Set<string>();
  const thaans = new Set<string>();

  if (colourInputs.length === 0) issues.push({ path: "colours", message: "Add at least one colour." });

  const colours = colourInputs.map((colour, colourIndex): ColourResult => {
    const path = `colours.${colourIndex}`;
    const name = colour.name.trim();

    if (!name) issues.push({ path: `${path}.name`, message: "Enter the colour." });
    else if (colourNames.has(name.toLowerCase())) issues.push({ path: `${path}.name`, message: `${name} is listed twice.` });

    colourNames.add(name.toLowerCase());

    if (colour.rolls.length === 0) issues.push({ path: `${path}.rolls`, message: "Add at least one Thaan." });

    const colourTotals = emptyTotals();

    const rolls = colour.rolls.map((roll, rollIndex) => {
      const rollPath = `${path}.rolls.${rollIndex}`;
      const thaan = roll.thaan.trim();

      if (!thaan) issues.push({ path: `${rollPath}.thaan`, message: "Enter the Thaan number." });
      else if (thaans.has(thaan.toLowerCase())) issues.push({ path: `${rollPath}.thaan`, message: `Thaan ${thaan} is listed twice.` });

      thaans.add(thaan.toLowerCase());

      const result = calculateRoll(roll, marker, markerInput.repetitionsPerLayer, rollPath, issues);

      if (marker.activePalaKg && result.netKg > 0n && result.estimatedPala === 0) {
        warnings.push({
          path: `${rollPath}.issuedKg`,
          message: `Less than one Pala: all ${formatKg(result.netKg)} kg of Thaan ${thaan || rollIndex + 1} becomes wastage unless returned.`,
        });
      }

      addTotals(colourTotals, {
        issuedKg: result.issuedKg,
        returnedKg: result.returnedKg,
        consumedKg: result.consumedKg,
        wastageKg: result.wastageKg,
        estimatedPala: result.estimatedPala,
        confirmedPala: result.confirmedPala,
        plannedPieces: result.pieces,
        acceptedPieces: result.pieces,
      });

      return result;
    });

    const sizes = markerInput.sizes.map((size): SizeOutput => {
      const planned = colourTotals.confirmedPala * (Number.isInteger(size.piecesPerPala) ? size.piecesPerPala : 0);

      return { label: size.label.trim(), planned, accepted: planned };
    });

    colourTotals.plannedPieces = sizes.reduce((sum, size) => sum + size.planned, 0);
    colourTotals.acceptedPieces = sizes.reduce((sum, size) => sum + size.accepted, 0);
    addTotals(totals, colourTotals);

    return { name, rolls, totals: colourTotals, sizes };
  });

  return { marker, colours, totals, issues, warnings };
}

/** Kilograms × rate per kg (4 decimals) → paisa, rounded half up. */
export function costOf(micro: bigint, ratePerKg: string): bigint {
  const rate = parseScaled(ratePerKg, 4) ?? 0n;

  // 6 + 4 decimals → keep 2.
  return divideRounded(micro * rate, 10n ** 8n);
}

export interface Earning {
  /** Paid quantity in micro-units (pieces, Pala, kg or one job). */
  quantity: bigint;
  /** Paisa. */
  amount: bigint;
}

/** What a cutting master earns for one finalized batch; null for salaried / daily-paid workers. */
export function cuttingEarning(mode: PayMode, rate: string, work: Totals): Earning | null {
  const quantity = {
    PER_PIECE: BigInt(work.acceptedPieces) * KG,
    PER_PALA: BigInt(work.confirmedPala) * KG,
    PER_KG: work.consumedKg,
    FIXED_JOB: KG,
    SALARY: null,
  }[mode];

  if (quantity === null) return null;

  // micro-units × rupees at 2 decimals → paisa.
  return { quantity, amount: divideRounded(quantity * (parseScaled(rate, 2) ?? 0n), KG) };
}
