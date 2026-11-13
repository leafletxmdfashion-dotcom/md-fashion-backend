// Garment sizes in the order people read them: letter sizes small to large, then numbers
// ascending, then anything else alphabetically. Used where no cutting order is at hand.
const LETTERS = ["XXS", "XS", "S", "M", "L", "XL", "XXL", "3XL", "4XL", "5XL"];

const ALIASES: Record<string, string> = { "2XL": "XXL", XXXL: "3XL" };

function rank(size: string): [number, number, string] {
  const label = size.trim().toUpperCase();
  const letter = LETTERS.indexOf(ALIASES[label] ?? label);

  if (letter >= 0) return [0, letter, label];

  const number = Number(label);

  if (label !== "" && Number.isFinite(number)) return [1, number, label];

  return [2, 0, label];
}

export function compareSizes(a: string, b: string): number {
  const [ga, na, la] = rank(a);
  const [gb, nb, lb] = rank(b);

  return ga - gb || na - nb || la.localeCompare(lb);
}
