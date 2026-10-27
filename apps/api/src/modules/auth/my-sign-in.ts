/**
 * How an account signs in, read for the person it belongs to (D-176, D-179 §5): the card "How you sign
 * in" on Sessions & account. Read-only: a GitHub account is linked by the sign-in itself, on one
 * verified address, and there is nothing to press.
 */
import type { MySignIn } from '@purlay/types';
import type { Executor } from '@purlay/db';
import { AppError } from '../../platform/errors';
import { madeByGitHub } from './magic-link';
import { OIDC_PROVIDER_ID } from './oidc';

/**
 * The ways an account signs in: its address, whether a link to it signs in — an account made by
 * email, linked to GitHub or not, and never one GitHub made (D-138 §2) — and its GitHub account, if any.
 */
export const mySignIn = async (executor: Executor, userId: string): Promise<MySignIn> => {
  const row = await executor
    .selectFrom('users')
    .select(['email', 'github_id', 'github_login', 'github_connected_at'])
    .where('id', '=', userId)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  if (row === undefined) {
    throw new AppError({
      code: 'UNAUTHENTICATED',
      message: 'This account is not signed in here any more.',
    });
  }
  const credential = await executor
    .selectFrom('accounts')
    .select('id')
    .where('user_id', '=', userId)
    .where('provider_id', '=', 'credential')
    .where('password', 'is not', null)
    .executeTakeFirst();
  const sso = await executor
    .selectFrom('accounts')
    .select('id')
    .where('user_id', '=', userId)
    .where('provider_id', '=', OIDC_PROVIDER_ID)
    .executeTakeFirst();
  return {
    email: row.email,
    hasPassword: credential !== undefined,
    emailLinks: !madeByGitHub(row),
    github: row.github_id === null ? null : { login: row.github_login },
    oidc: sso !== undefined,
  };
};
