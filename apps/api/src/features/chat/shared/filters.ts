/** Validate real instants before hashing filters or giving them to PostgreSQL. */
import type { SharedQuery } from '@purlay/types';
import { AppError } from '../../../platform/errors';

const instant = (value: string, field: 'since' | 'until'): string => {
  const parsed = new Date(value);
  // Date.parse accepts February 31 and 24:00 by rolling them over. Validate the wall clock too,
  // separately from the offset, so equivalent offset spellings still have one cursor scope.
  const wall = new Date(`${value.slice(0, 19)}Z`);
  if (
    !Number.isFinite(parsed.getTime()) ||
    !Number.isFinite(wall.getTime()) ||
    wall.toISOString().slice(0, 19) !== value.slice(0, 19)
  )
    throw new AppError({
      code: 'VALIDATION_FAILED',
      message: 'Choose a valid date.',
      details: { fields: { [field]: 'Must be a valid date and time.' } },
    });
  return parsed.toISOString();
};

export const sharedFilters = (input: SharedQuery): SharedQuery => ({
  ...input,
  ...(input.since === undefined ? {} : { since: instant(input.since, 'since') }),
  ...(input.until === undefined ? {} : { until: instant(input.until, 'until') }),
});
