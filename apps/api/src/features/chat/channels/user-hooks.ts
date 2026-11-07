/**
 * What chat forgets when an account is erased (D-139 §5, D-250): the messages they deleted for themselves, their
 * reminders and scheduled messages (whose reserved files go back to the orphan sweep), the searches and messages
 * they saved, the threads they followed, their inbox, and when they were last mailed about what they missed (D-240), and the sealed tokens they gave the GitHub App (D-246), which GitHub is then asked to revoke (#993), and their own login on an installation of the App on their personal account (#997). Registered
 * where the application is put together; the account code names none of these tables, and runs the hooks inside
 * the erasure's own transaction, at the place these deletes always ran.
 */
import { tableExists } from '@purlay/db';
import { hookList, type HookList } from '../../../platform/hooks';
import type { UserErased } from '../../../modules/users/erasure';
import { revokeErasedAuthorization } from '../integrations/github-app';

/** The hook itself: what chat deletes of a person, in the erasure's transaction. */
export const forgetWhatChatKeeps = async (
  ...[transaction, userId, afterCommit]: Parameters<UserErased['run']>
): Promise<void> => {
  // Made by chat's own migration set, so absent from a database migrated without it, where there is nothing to forget.
  // `channel_departures` is how they left a channel, which names them (D-264).
  for (const table of [
    'hidden_messages',
    'message_reminders',
    'scheduled_messages',
    'channel_departures',
    'thread_reads',
    'channel_read_scopes',
    'channel_group_channels',
    'channel_groups',
  ] as const) {
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
  // cascades from `users`, which an erasure keeps as the tombstone, so it never fires. What it sealed is taken
  // here and revoked at GitHub once the erasure has committed, so no call to GitHub is made while the
  // transaction holds its locks, and none can undo the erasure (#993).
  // And the login of the personal account they installed the App on, which is their own GitHub login: replaced by the
  // name their account now has (`deleted-user-…`, as it is in `users`, which the erasure has just written). The
  // installation stays the workspace's, and an organisation's login names an organisation, not a person, so it stays.
  // The trail's `{ account }` on the connect and disconnect lines is not rewritten: it is append-only (I-9).
  await transaction
    .updateTable('github_app_installations')
    .set((eb) => ({
      account_login: eb.selectFrom('users').select('username').where('users.id', '=', userId),
    }))
    .where('connected_by', '=', userId)
    .where('account_type', '=', 'User')
    .execute();
  const authorizations = await transaction
    .deleteFrom('github_user_authorizations')
    .where('user_id', '=', userId)
    .returning(['id', 'access_token_encrypted', 'refresh_token_encrypted'])
    .execute();
  for (const authorization of authorizations) {
    afterCommit(async (services) => {
      await revokeErasedAuthorization(services, authorization);
    });
  }
};

export const chatUserErased = (): HookList<Parameters<UserErased['run']>> => {
  const hooks = hookList<Parameters<UserErased['run']>>();
  hooks.register(forgetWhatChatKeeps);
  return hooks;
};
