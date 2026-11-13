// Readable names for stored codes, as the screens show them; used by CSV exports.

export const BATCH_STATUS_LABEL: Record<string, string> = {
  DRAFT: "Draft",
  ISSUED: "Fabric issued",
  FINALIZED: "Finalized",
  REVERSED: "Reversed",
};

export const REWORK_STATUS_LABEL: Record<string, string> = {
  PENDING: "Pending",
  ASSIGNED: "Assigned",
  IN_PROGRESS: "In progress",
  COMPLETED: "Completed",
  FAILED: "Failed",
  CANCELLED: "Cancelled",
};

export const CATEGORY_LABEL: Record<string, string> = {
  CUTTING_MASTER: "Cutting master",
  TAILOR: "Tailor",
  HELPER: "Helper",
  PACKER: "Packer",
  STAFF: "Staff",
  OTHER: "Other",
};

export const PAY_MODE_LABEL: Record<string, string> = {
  PER_PIECE: "Per piece",
  PER_PALA: "Per Pala",
  PER_KG: "Per kg cut",
  FIXED_JOB: "Fixed per job",
  SALARY: "Daily / salary",
};

/** Label for a code, falling back to the code itself for values added later. */
export const label = (map: Record<string, string>, code: string | null | undefined) =>
  code === null || code === undefined ? null : (map[code] ?? code);

export const unitShort = (unit: string | null | undefined) => (unit === "METER" ? "m" : "kg");

/** Staff / karigar code, e.g. K-007. */
export const karigarCode = (number: number) => `K-${String(number).padStart(3, "0")}`;
