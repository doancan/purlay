/**
 * What chat forgets when an account is erased (D-139 §5, D-250): the searches and messages they saved, the
 * threads they followed, their inbox, and when they were last mailed about what they missed (D-240). Registered
 * where the application is put together; the account code names none of these tables, and runs the hooks inside
 * the erasure's own transaction, at the place these deletes always ran.
 */
import { hookList, type HookList } from '../../../platform/hooks';
import type { UserErased } from '../../../modules/users/erasure';

/** The hook itself: what chat deletes of a person, in the erasure's transaction. */
export const forgetWhatChatKeeps = async (
  ...[transaction, userId]: Parameters<UserErased['run']>
): Promise<void> => {
  await transaction.deleteFrom('saved_searches').where('user_id', '=', userId).execute();
  await transaction.deleteFrom('saved_messages').where('user_id', '=', userId).execute();
  await transaction.deleteFrom('thread_follows').where('user_id', '=', userId).execute();
  await transaction.deleteFrom('notifications').where('user_id', '=', userId).execute();
  // And when they were last mailed about what they missed, with each letter's stop link (D-240).
  await transaction.deleteFrom('missed_mail_letters').where('user_id', '=', userId).execute();
};

export const chatUserErased = (): HookList<Parameters<UserErased['run']>> => {
  const hooks = hookList<Parameters<UserErased['run']>>();
  hooks.register(forgetWhatChatKeeps);
  return hooks;
};
