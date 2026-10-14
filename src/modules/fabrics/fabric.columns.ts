import type { ColumnSpecs } from "../../lib/list-query";

// Filterable/sortable columns of each fabric list. Keys are the query-string names;
// the SQL refers to the aliases used in fabric.repository.ts.

export const MOVEMENT_TYPES = [
  "PURCHASE_IN",
  "PURCHASE_REVERSAL",
  "ADJUSTMENT_IN",
  "ADJUSTMENT_OUT",
  "CUTTING_ISSUE",
  "CUTTING_RETURN",
] as const;

// ponytail: weighted average of all live purchases; switch to FIFO lots if costing needs it.
export const AVG_RATE = "(s.purchased_amount / nullif(s.purchased_qty, 0))";
export const STOCK_VALUE = `round(s.balance * COALESCE(${AVG_RATE}, 0), 2)`;

export const FABRIC_COLUMNS: ColumnSpecs = {
  fabric: { type: "text", sql: "f.search_text", sortSql: "f.name" },
  balance: { type: "number", sql: "s.balance" },
  threshold: { type: "number", sql: "f.low_stock_threshold" },
  avgRate: { type: "number", sql: AVG_RATE },
  stockValue: { type: "number", sql: STOCK_VALUE },
};

export const INWARD_COLUMNS: ColumnSpecs = {
  date: { type: "date", sql: "i.inward_date" },
  number: { type: "number", sql: "i.number" },
  fabric: { type: "text", sql: "f.search_text", sortSql: "f.name" },
  quantity: { type: "number", sql: "i.quantity" },
  rate: { type: "number", sql: "i.rate" },
  amount: { type: "number", sql: "i.amount" },
  // search_text (trigram-indexed) narrows the rows before the exact column match.
  supplier: {
    type: "text",
    sql: "lower(COALESCE(i.supplier, '') || ' ' || COALESCE(i.invoice_ref, ''))",
    sortSql: "i.supplier",
    prefilter: "i.search_text",
  },
  status: {
    type: "enum",
    sql: "CASE WHEN i.reversed_at IS NULL THEN 'posted' ELSE 'reversed' END",
    values: ["posted", "reversed"],
  },
};

export const MOVEMENT_COLUMNS: ColumnSpecs = {
  date: { type: "date", sql: "m.movement_date" },
  type: { type: "enum", sql: "m.type", values: MOVEMENT_TYPES },
  fabricName: { type: "text", sql: "f.search_text", sortSql: "f.name" },
  qtyIn: { type: "number", sql: "m.qty_in" },
  qtyOut: { type: "number", sql: "m.qty_out" },
  createdBy: { type: "text", sql: "lower(COALESCE(u.name, ''))", sortSql: "u.name" },
};
