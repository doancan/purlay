/**
 * The boundary both doors share (#195): a new transaction that commits or leaves
 * nothing, or the caller's, joined rather than nested.
 *
 * On a cloned database, because committing is the behaviour under test and a
 * rolled-back harness transaction would hide it (D-46).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { cloneIntegrationDatabase, type ClonedDatabase } from '@purlay/db';
import { atomicallyOn } from './transactions';

let cloned: ClonedDatabase;

beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
});

afterAll(async () => {
  await cloned.drop();
});

/** This file's rows only, by the prefix every slug here carries. */
const slugs = async (): Promise<string[]> =>
  (
    await cloned.db
      .selectFrom('workspaces')
      .select('slug')
      .where('slug', 'like', 'tx-%')
      .orderBy('slug')
      .execute()
  ).map((row) => row.slug);

describe('integration: the transaction boundary', () => {
  test('outside a transaction, the body commits as one when it returns', async () => {
    await atomicallyOn(cloned.db)(async (executor) => {
      expect(executor.isTransaction).toBe(true);
      await executor.insertInto('workspaces').values({ name: 'A', slug: 'tx-commits-a' }).execute();
      await executor.insertInto('workspaces').values({ name: 'B', slug: 'tx-commits-b' }).execute();
    });
    expect(await slugs()).toEqual(
      expect.arrayContaining(['tx-commits-a', 'tx-commits-b']) as string[],
    );
  });

  test('a body that throws leaves nothing behind, not even what it wrote first', async () => {
    const failure = await atomicallyOn(cloned.db)(async (executor) => {
      await executor
        .insertInto('workspaces')
        .values({ name: 'C', slug: 'tx-rolls-back' })
        .execute();
      throw new Error('the second write failed');
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect(await slugs()).not.toContain('tx-rolls-back');
  });

  test('inside a transaction, it joins it: one boundary, decided by the outermost', async () => {
    const joined = await cloned.db
      .transaction()
      .execute(async (outer) => {
        await atomicallyOn(outer)(async (executor) => {
          // The same transaction, not a nested one Kysely would refuse.
          expect(executor).toBe(outer);
          await executor.insertInto('workspaces').values({ name: 'D', slug: 'tx-joins' }).execute();
        });
        throw new Error('the outer transaction decides');
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(joined).toBeInstanceOf(Error);
    expect(await slugs()).not.toContain('tx-joins');
  });
});
