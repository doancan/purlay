/**
 * The arithmetic of a month grid, on calendar days written `YYYY-MM-DD`.
 *
 * A day is a string here, never a `Date`: a date field holds a day, not an instant, and a `Date`
 * drags a time zone in with it. Every step goes through UTC so a clock change never moves a day.
 */
const parse = (day: string): Date => {
  const [y = 1970, m = 1, d = 1] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
};

const write = (date: Date): string => date.toISOString().slice(0, 10);

export const isDay = (value: string): boolean =>
  /^\d{4}-\d{2}-\d{2}$/.test(value) && write(parse(value)) === value;

export const addDays = (day: string, count: number): string => {
  const date = parse(day);
  date.setUTCDate(date.getUTCDate() + count);
  return write(date);
};

/** The same day-of-month `count` months on, held to the last day of a shorter month. */
export const addMonths = (day: string, count: number): string => {
  const date = parse(day);
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + count, 1));
  const last = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(date.getUTCDate(), last));
  return write(target);
};

export const monthOf = (day: string): string => day.slice(0, 7);

/** Whole weeks, Monday first, that cover the month of `day`; days outside it are the neighbours'. */
export const monthGrid = (day: string): readonly (readonly string[])[] => {
  const first = `${monthOf(day)}-01`;
  const offset = (parse(first).getUTCDay() + 6) % 7;
  const start = addDays(first, -offset);
  const weeks: string[][] = [];
  for (let week = 0; week < 6; week++) {
    const row = Array.from({ length: 7 }, (_, index) => addDays(start, week * 7 + index));
    if (week >= 4 && monthOf(row[0] ?? first) !== monthOf(first)) break;
    weeks.push(row);
  }
  return weeks;
};
