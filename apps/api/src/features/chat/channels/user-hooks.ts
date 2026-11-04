/**
 * What chat forgets when an account is erased (D-139 §5, D-250): the messages they deleted for themselves, their
 * reminders and scheduled messages (whose reserved files go back to the orphan sweep), the searches and messages
 * they saved, the threads they followed, their inbox, and when they were last mailed about what they missed (D-240), and the sealed tokens they gave the GitHub App (D-246). Registered
 * where the application is put together; the account code names none of these tables, and runs the hooks inside
 * the erasure's own transaction, at the place these deletes always ran.
 */
import { tableExists } from '@purlay/db';
import { hookList, type HookList } from '../../../platform/hooks';
import type { UserErased } from '../../../modules/users/erasure';

/** The hook itself: what chat deletes of a person, in the erasure's transaction. */
export const forgetWhatChatKeeps = async (
  ...[transaction, userId]: Parameters<UserErased['run']>
): Promise<void> => {
  // Made by chat's own migration set, so absent from a database migrated without it, where there is nothing to forget.
  for (const table of ['hidden_messages', 'message_reminders', 'scheduled_messages'] as const) {
    if (await tableExists(transaction, table)) {
      await transaction.deleteFrom(table).where('user_id', '=', userId).execute();
    }
  }
  await transaction.deleteFrom('saved_searches').where('user_id', '=', userId).execute();
  await transaction.deleteFrom('saved_messages').where('user_id', '=', userId).execute();
  await transaction.deleteFrom('thread_follows').where('user_id', '=', userId).execute();
  await transaction.deleteFrom('notifications').where('user_id', '=', userId).execute();
  // And when they were last mailed about what they missed, with each letter's stop link (D-240).
  await transaction.deleteFrom('missed_mail_letters').where('user_id', '=', userId).execute();
  // And the sealed tokens that let the App write to GitHub as them, with their GitHub login (D-246): the row's key
  // cascades from `users`, which an erasure keeps as the tombstone, so it never fires.
  await transaction
    .deleteFrom('github_user_authorizations')
    .where('user_id', '=', userId)
    .execute();
};

export const chatUserErased = (): HookList<Parameters<UserErased['run']>> => {
  const hooks = hookList<Parameters<UserErased['run']>>();
  hooks.register(forgetWhatChatKeeps);
  return hooks;
};
