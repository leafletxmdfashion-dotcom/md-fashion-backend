import { describe, expect, it } from "vitest";
import { z } from "zod";

import { queryRows, rowQueryFields, type RowQuery, type RowSpecs } from "./row-query";

interface Row {
  id: string;
  name: string;
  pieces: number | null;
  day: string | null;
  kind: string;
}

const SPECS: RowSpecs<Row> = {
  name: { type: "text", value: (row) => row.name },
  pieces: { type: "number", value: (row) => row.pieces },
  day: { type: "date", value: (row) => row.day },
  kind: { type: "enum", values: ["A", "B"], value: (row) => row.kind },
};

const ROWS: Row[] = [
  { id: "1", name: "Ram", pieces: 10, day: "2026-11-01", kind: "A" },
  { id: "2", name: "sita", pieces: null, day: null, kind: "B" },
  { id: "3", name: "Asha", pieces: 10, day: "2026-11-13", kind: "A" },
  { id: "4", name: "Bina", pieces: 2, day: "2026-10-30", kind: "B" },
];

const parse = (params: Record<string, string>) => z.object(rowQueryFields(SPECS)).parse(params) as RowQuery;
const ids = (params: Record<string, string>) =>
  queryRows(ROWS, SPECS, parse(params), (row) => row.name).matching.map((row) => row.id);

describe("queryRows", () => {
  it("filters like the SQL lists: contains, any-of, inclusive ranges; blanks never match a range", () => {
    expect(ids({ name: "SI" })).toEqual(["2"]);
    expect(ids({ kind: "B" })).toEqual(["2", "4"]);
    expect(ids({ piecesMin: "2", piecesMax: "10" })).toEqual(["1", "3", "4"]);
    expect(ids({ dayFrom: "2026-11-01", dayTo: "2026-11-13" })).toEqual(["1", "3"]);
    expect(ids({ search: "a" })).toEqual(["1", "2", "3", "4"]);
  });

  it("sorts stably either way with blanks last, and pages only when asked", () => {
    expect(ids({ sort: "pieces", dir: "asc" })).toEqual(["4", "1", "3", "2"]);
    expect(ids({ sort: "pieces", dir: "desc" })).toEqual(["1", "3", "4", "2"]);
    expect(ids({ sort: "name" })).toEqual(["3", "4", "1", "2"]);

    const paged = queryRows(ROWS, SPECS, parse({ page: "2", pageSize: "3" }), (row) => row.name);
    expect(paged.page.map((row) => row.id)).toEqual(["4"]);
    expect(paged.total).toBe(4);
    expect(queryRows(ROWS, SPECS, parse({}), (row) => row.name).page).toHaveLength(4);
  });

  it("rejects unknown enum values and sort keys", () => {
    expect(() => parse({ kind: "C" })).toThrow();
    expect(() => parse({ sort: "id" })).toThrow();
  });
});
