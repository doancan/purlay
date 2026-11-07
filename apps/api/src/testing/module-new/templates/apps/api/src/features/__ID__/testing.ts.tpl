/**
 * What the tests that walk every module need of __ID__ (`MODULES.md` §9): `seedLifecycle` writes a row of each table it owns
 * into a workspace, so that erasure, purge and export are proven on something (`module-lifecycle.integration.test.ts`
 * finds this file by its folder). Test code: nothing in the product imports it.
 */
import { messageId as newId } from '@purlay/types';
import type { __PASCAL__Tx } from './schema';

/** A fixed moment: the id of a row, and nothing else here reads the clock. */
const SEEDED_AT = new Date('2026-01-01T00:00:00Z');

export const seedLifecycle = async (
  transaction: __PASCAL__Tx,
  workspaceId: string,
): Promise<void> => {
  await transaction
    .insertInto('__SNAKE__')
    .values({ id: newId(SEEDED_AT), workspace_id: workspaceId, title: 'seeded for the lifecycle' })
    .execute();
};
