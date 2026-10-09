/**
 * What the integration harness does when there is no database, or one that does not
 * answer. The unit half: nothing here connects to anything.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { integrationDatabase, prepareTemplateForRun } from './testing';

const original = process.env['DATABASE_URL'];

afterEach(() => {
  if (original === undefined) delete process.env['DATABASE_URL'];
  else process.env['DATABASE_URL'] = original;
});

describe('the preload that prepares the template', () => {
  test('does nothing without a database, which is a run of unit tests', async () => {
    delete process.env['DATABASE_URL'];
    let prepared = 0;
    const warnings: string[] = [];
    await prepareTemplateForRun(
      () => {
        prepared += 1;
        return Promise.resolve();
      },
      (message) => warnings.push(message),
    );
    expect({ prepared, warnings }).toEqual({ prepared: 0, warnings: [] });
  });

  test('prepares once when a database is configured', async () => {
    process.env['DATABASE_URL'] = 'postgres://nobody@localhost:1/none';
    let prepared = 0;
    await prepareTemplateForRun(
      () => {
        prepared += 1;
        return Promise.resolve();
      },
      () => undefined,
    );
    expect(prepared).toBe(1);
  });

  test('warns, and does not throw, when the database does not answer', async () => {
    process.env['DATABASE_URL'] = 'postgres://nobody@localhost:1/none';
    const warnings: string[] = [];
    await prepareTemplateForRun(
      () => Promise.reject(new Error('connect ECONNREFUSED')),
      (message) => warnings.push(message),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('ECONNREFUSED');
  });

  test('and a helper asked for a database without one refuses, rather than proving nothing', () => {
    delete process.env['DATABASE_URL'];
    expect(() => integrationDatabase()).toThrow('DATABASE_URL is not set');
  });
});
