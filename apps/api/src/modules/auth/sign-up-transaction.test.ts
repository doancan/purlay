import { expect, test } from 'bun:test';
import { unconnectedDatabase } from '@purlay/db';
import { rememberingTransactions } from './sign-up-transaction';

test('the transaction wrapper preserves non-method database metadata', async () => {
  const database = unconnectedDatabase();
  try {
    expect(rememberingTransactions(database).isTransaction).toBe(false);
  } finally {
    await database.destroy();
  }
});
