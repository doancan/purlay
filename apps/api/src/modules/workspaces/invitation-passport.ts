/**
 * The invitation passport (D-179 §5, Ruling R51): how a newcomer makes an account on an invite-only
 * server — by a live invitation link, and by nothing else.
 *
 * A link (D-115) is a bearer secret for joining a workspace, and joining needs an account. On an
 * invite-only server the door to accounts is shut, so a link cannot ride through it by itself: the person
 * holding it asks for a *passport*, made from the link, which the sign-up that follows spends.
 *
 * - **Two kinds, by how the sign-up comes back.** `github`: the browser is given a random cookie, only the
 *   digest of which is kept, and its return from GitHub shows it. `email`: for an address, no cookie —
 *   the mail's link may be opened in another browser — and the sign-in by link (`magic-link.ts`) lets that
 *   one address through. Neither is ever stored: a copy of the database spends nothing and names nobody.
 * - **Made from a link that opens**, by the preview's own rules (`linkOpens`) and refused with the
 *   preview's own answer — `INVITATION_NOT_FOUND`, saying nothing about which way the link failed — and
 *   **only as live as the link**: every use reads the link again, so a revoked, expired or deleted-with-its-
 *   workspace link takes its unspent passports with it. (A removed member is the preview's one more
 *   refusal; a newcomer has no membership to have lost, so there is nothing here to read.)
 * - **An hour, once.** Spending is one update that only one caller can win (`consumePassport`), made in
 *   the transaction that inserts the account (`better-auth.ts`), so an account that is not made spends
 *   nothing and two sign-ups with one passport make one account.
 * - **At most twenty live per link**, counted under a lock on the link's row so two requests at once
 *   cannot both take the twentieth; a refusal is `too-many`. An address asking again for the same link
 *   replaces its own passport rather than adding one.
 * - **Never an oracle**: nothing here says whether an address has an account — a passport for one that
 *   does is made and never read, since a passport is for creating.
 */
import type { Executor, Transaction } from '@purlay/db';
import { messageId, normalisedMailbox } from '@purlay/types';
import { HOUR_MS, type Clock } from '../../platform/clock';
import { randomToken, tokenDigest } from '../../platform/tokens';
import { linkOpens, notFound } from './invitations';

/** How long a passport lasts: long enough to go to GitHub and back, or to open a mail. */
export const PASSPORT_TTL_MS = HOUR_MS;

/** How many unexpired, unspent passports one link may have at once. */
export const PASSPORTS_PER_INVITATION = 20;

/** Why a passport was not made, past the link itself being refused (which is `INVITATION_NOT_FOUND`). */
export class PassportRefused extends Error {
  readonly reason: 'too-many' | 'invalid-address';

  constructor(reason: 'too-many' | 'invalid-address') {
    super(`an invitation passport was refused: ${reason}`);
    this.name = 'PassportRefused';
    this.reason = reason;
  }
}

/** The id of a passport that was found to allow a sign-up. */
export type PassportId = string;

/** What a passport is looked up by: a browser's cookie, or an address. */
export interface PassportPresented {
  readonly cookie?: string | undefined;
  readonly email?: string | undefined;
}

/** What is stored for an address: the SHA-256 of it, lower-cased and trimmed (D-40) — or nothing, for a non-address. */
const addressDigest = async (typed: string): Promise<string | undefined> => {
  const address = normalisedMailbox(typed);
  return address === undefined ? undefined : await tokenDigest(address);
};

/** The digest an erasure deletes an address's passports by, read before the tombstone replaces the address. */
export const passportAddressDigest = addressDigest;

/**
 * A passport from the link `token`: for `email` if one is given, otherwise for the browser asking — its
 * cookie value returned, this once. Takes a transaction: the link's row is locked while the live ones
 * are counted and one is written.
 */
export const issuePassport = async (
  transaction: Transaction,
  clock: Clock,
  { token, email }: { readonly token: string; readonly email?: string | undefined },
): Promise<{ cookie?: string }> => {
  const now = clock.now();
  const link = await transaction
    .selectFrom('workspace_invitations')
    .innerJoin('workspaces', 'workspaces.id', 'workspace_invitations.workspace_id')
    .select('workspace_invitations.id')
    .where('workspace_invitations.token_hash', '=', await tokenDigest(token))
    .where((eb) => linkOpens(eb, now))
    // Held to the end of the transaction: the one lock every passport of this link is made under.
    .forNoKeyUpdate(['workspace_invitations'])
    .executeTakeFirst();
  if (link === undefined) throw notFound();

  // After the link, never before: a link that does not open is one answer whatever else was sent.
  const address = email === undefined ? undefined : await addressDigest(email);
  if (email !== undefined && address === undefined) throw new PassportRefused('invalid-address');

  // An address's own live passport for this link is replaced, not added to: it is not counted against it.
  const live = await transaction
    .selectFrom('invitation_passports')
    .select((eb) => eb.fn.countAll<string>().as('live'))
    .where('invitation_id', '=', link.id)
    .where('consumed_at', 'is', null)
    .where('expires_at', '>', now)
    .$if(address !== undefined, (query) =>
      query.where((eb) =>
        eb.or([eb('address_digest', 'is', null), eb('address_digest', '<>', address ?? '')]),
      ),
    )
    .executeTakeFirstOrThrow();
  if (Number(live.live) >= PASSPORTS_PER_INVITATION) throw new PassportRefused('too-many');

  const expiresAt = new Date(now.getTime() + PASSPORT_TTL_MS);
  if (address !== undefined) {
    await transaction
      .insertInto('invitation_passports')
      .values({
        id: messageId(now),
        invitation_id: link.id,
        kind: 'email',
        address_digest: address,
        expires_at: expiresAt,
      })
      // Re-arms a used e-mail passport on purpose: a person who asks again for the same address gets a fresh pass.
      .onConflict((conflict) =>
        conflict
          .columns(['invitation_id', 'address_digest'])
          .doUpdateSet({ expires_at: expiresAt, consumed_at: null }),
      )
      .execute();
    return {};
  }
  const cookie = randomToken();
  await transaction
    .insertInto('invitation_passports')
    .values({
      id: messageId(now),
      invitation_id: link.id,
      kind: 'github',
      cookie_digest: await tokenDigest(cookie),
      expires_at: expiresAt,
    })
    .execute();
  return { cookie };
};

/**
 * The passport this cookie or this address holds, if it allows a sign-up now: unspent, unexpired, and its
 * link still opening. Reads only; the digests are compared by the database's equality on a value that
 * was never a secret to be guessed along — 256 random bits hashed, or a hash of an address.
 */
export const passportAllows = async (
  executor: Executor,
  clock: Clock,
  presented: PassportPresented,
): Promise<PassportId | undefined> => {
  const now = clock.now();
  const cookie =
    presented.cookie === undefined || presented.cookie === ''
      ? undefined
      : await tokenDigest(presented.cookie);
  const address = presented.email === undefined ? undefined : await addressDigest(presented.email);
  if (cookie === undefined && address === undefined) return undefined;
  const row = await executor
    .selectFrom('invitation_passports')
    .innerJoin(
      'workspace_invitations',
      'workspace_invitations.id',
      'invitation_passports.invitation_id',
    )
    .innerJoin('workspaces', 'workspaces.id', 'workspace_invitations.workspace_id')
    .select('invitation_passports.id')
    .where('invitation_passports.consumed_at', 'is', null)
    .where('invitation_passports.expires_at', '>', now)
    .where((eb) => linkOpens(eb, now))
    .where((eb) =>
      eb.or([
        ...(cookie === undefined
          ? []
          : [
              eb.and([
                eb('invitation_passports.kind', '=', 'github'),
                eb('invitation_passports.cookie_digest', '=', cookie),
              ]),
            ]),
        ...(address === undefined
          ? []
          : [
              eb.and([
                eb('invitation_passports.kind', '=', 'email'),
                eb('invitation_passports.address_digest', '=', address),
              ]),
            ]),
      ]),
    )
    .orderBy('invitation_passports.expires_at')
    .limit(1)
    .executeTakeFirst();
  return row?.id;
};

/**
 * Spends a passport, in the transaction of the sign-up that uses it (the library's, which the hook is given: one statement is atomic wherever it runs, but only inside that transaction is it undone with the account). One statement decides: unspent,
 * unexpired and its link still opening when it runs, so of two sign-ups with one passport the second waits
 * for the first to commit, finds it spent, and is refused. Whether this call spent it.
 */
export const consumePassport = async (
  executor: Executor,
  id: PassportId,
  clock: Clock,
): Promise<boolean> => {
  const now = clock.now();
  const spent = await executor
    .updateTable('invitation_passports')
    .set({ consumed_at: now })
    .where('id', '=', id)
    .where('consumed_at', 'is', null)
    .where('expires_at', '>', now)
    .where((eb) =>
      eb.exists(
        eb
          .selectFrom('workspace_invitations')
          .innerJoin('workspaces', 'workspaces.id', 'workspace_invitations.workspace_id')
          .select('workspace_invitations.id')
          .whereRef('workspace_invitations.id', '=', 'invitation_passports.invitation_id')
          .where((inner) => linkOpens(inner, now)),
      ),
    )
    .returning('id')
    .executeTakeFirst();
  return spent !== undefined;
};
