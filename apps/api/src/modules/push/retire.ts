/** Parents must already be locked. Never cascade while any child is owned by another transaction. */
import type { Transaction } from '@purlay/db';

export const retirePushIntents = async (
  transaction: Transaction,
  ids: readonly string[],
): Promise<readonly string[]> => {
  if (ids.length === 0) return [];
  // Parent locks prevent new children. Compare the complete child set with the locks obtained
  // in one fresh snapshot; logout/410 may own several children in a different parent order.
  const ready = await transaction
    .with('locked_targets', (db) =>
      db
        .selectFrom('push_deliveries')
        .select('intent_id')
        .where('intent_id', 'in', ids)
        .forUpdate()
        .skipLocked(),
    )
    .selectFrom('push_intents as p')
    .select('p.id')
    .where('p.id', 'in', ids)
    .where((eb) =>
      eb(
        eb
          .selectFrom('push_deliveries as d')
          .select((count) => count.fn.countAll<string>().as('n'))
          .whereRef('d.intent_id', '=', 'p.id'),
        '=',
        eb
          .selectFrom('locked_targets as held')
          .select((count) => count.fn.countAll<string>().as('n'))
          .whereRef('held.intent_id', '=', 'p.id'),
      ),
    )
    .execute();
  const retired = ready.map((row) => row.id);
  if (retired.length > 0)
    await transaction.deleteFrom('push_intents').where('id', 'in', retired).execute();
  return retired;
};
