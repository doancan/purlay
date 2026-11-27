/**
 * A consumer declared for one fact is handed that fact's payload typed by its declaration (D-353): `consumerOf` keys the handler by the
 * type and asks the schema once more, so a payload that does not fit is a throw and never a value of the wrong type in the handler.
 */
import { describe, expect, test } from 'bun:test';
import type { Transaction } from '@purlay/db';
import { passingAsItsClass } from '../testing/doubles';
import { NOTE_CREATED } from '../testing/facts';
import { consumerOf, type DeliveredFact } from './fact-consumers';
import { noPorts } from './ports/module-ports';
import { noSeam } from './ports/module-seams';

const delivery = (payload: unknown): DeliveredFact => ({
  type: 'notes.created',
  factId: '0199155c-0000-7b7f-8c11-2a4d3f9e1b70',
  workspaceId: '0199155c-0001-7b7f-8c11-2a4d3f9e1b70',
  modules: null,
  correlationId: 'fact:test',
  payload,
});
/** The handlers below never touch the transaction. */
const NO_TRANSACTION: Transaction = passingAsItsClass({});

describe('a consumer of one declared fact', () => {
  test('is keyed by the fact’s type and handed the payload as the declaration types it', async () => {
    const titles: string[] = [];
    const consumers = consumerOf(NOTE_CREATED, async ({ payload }) => {
      titles.push(payload.title);
      return await Promise.resolve('skipped' as const);
    });
    expect(Object.keys(consumers)).toEqual(['notes.created']);
    const handle = consumers['notes.created'];
    expect(
      await handle?.(delivery({ noteId: 'n', title: 'Plan' }), NO_TRANSACTION, noPorts, noSeam),
    ).toBe('skipped');
    expect(titles).toEqual(['Plan']);
  });

  test('throws for a payload its declaration refuses, and the handler is not asked', async () => {
    let asked = false;
    const handle = consumerOf(NOTE_CREATED, async () => {
      asked = true;
      return await Promise.resolve('done' as const);
    })['notes.created'];
    const refused = await handle?.(delivery({ noteId: 'n' }), NO_TRANSACTION, noPorts, noSeam).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(String(refused)).toContain(
      'the payload of "notes.created" does not fit its declaration',
    );
    expect(asked).toBe(false);
  });
});
