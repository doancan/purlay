/** Defuse spreadsheet formulas and quote RFC 4180 cells. Shared by both audit downloads. */
const FORMULA_START = /^[=+\-@\t\r]/;
export const csvCell = (value: string | null): string => {
  if (value === null) return '';
  const defused = FORMULA_START.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(defused) ? `"${defused.replaceAll('"', '""')}"` : defused;
};
