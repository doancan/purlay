import { describe, expect, test } from 'bun:test';
import { DEFAULT_JOB_DEADLINE_MS, jobDeadlinesOf } from './module-shares';

describe('the deadline of a module’s jobs', () => {
  const deadlineOf = jobDeadlinesOf([
    { id: 'plain' },
    { id: 'quick', jobDeadline: { ms: 5_000 } },
    { id: 'patient', jobDeadline: { none: 'it waits for a person' } },
  ]);

  test('is the default for a module that says nothing, what it says otherwise, and none where it declared none', () => {
    expect(deadlineOf('plain')).toBe(DEFAULT_JOB_DEADLINE_MS);
    expect(deadlineOf('quick')).toBe(5_000);
    expect(deadlineOf('patient')).toBeUndefined();
  });

  test('is not given for the core, which is no module of the build', () => {
    expect(deadlineOf('core')).toBeUndefined();
  });

  test('by default is longer than a request’s and shorter than an hour, the closest two of the plan’s slots are', () => {
    expect(DEFAULT_JOB_DEADLINE_MS).toBeGreaterThan(20_000);
    expect(DEFAULT_JOB_DEADLINE_MS).toBeLessThan(3_600_000);
  });
});
