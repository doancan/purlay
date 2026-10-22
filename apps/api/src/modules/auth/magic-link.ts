/**
 * Signing in by an email link (D-138, as amended by D-179): what is decided before Better Auth's
 * magic link is asked to make or spend one — the library makes the token, keeps its digest in
 * `verifications`, spends it once and makes the account; everything here is what it does not decide.
 *
 * - **The same answer whatever the address** (D-138 §1): asking is answered `202` by the caller
 *   whatever this decides, and showing or spending a link that does not open is one refusal —
 *   `SIGN_IN_LINK_NOT_FOUND` — for a link never made, spent, expired, or one whose account may not
 *   sign in by it. Whether an account has the address is never said.
 * - **Who a link signs in.** An account made by email or linked to GitHub, its address verified.
 *   Never an account GitHub made (D-138 §2: it is told to use GitHub instead), an erased one, or one
 *   whose address was never proven: the library would remove its password and end its sessions
 *   (D-179 §4, measured) — the setup administrator's is such an account (Ruling R32). An address no
 *   account has gets a link where sign-up is open, and where it is invite-only only while a passport
 *   made from an invitation link lives for exactly that address (`invitation-passport.ts`, R51).
 * - **Five messages an hour for an address, twenty requests an hour from a client** (D-138 §7,
 *   provisional, O-4), counted in the database so a restart or a second process hands nothing back
 *   (D-179, Q9), each by one statement that cannot be raced.
 * - **A link is shown before it is spent** (D-138 §4): the library has no preview, so its row is read
 *   here, by the same digest it keeps, and nothing is spent until the person presses *Sign in*.
 */
import type { Executor } from '@purlay/db';
import { normalisedMailbox, type EmailSignInPreview, type EmailSignInRequest } from '@purlay/types';
import { HOUR_MS, systemClock, type Clock } from '../../platform/clock';
import { passportAllows } from '../workspaces/invitation-passport';
import { AppError } from '../../platform/errors';
import type { Logger } from '../../platform/logging';
import { tokenDigest } from '../../platform/tokens';
import { counted } from './counters';
import type { SignInLinks } from './better-auth';
import { githubLetter } from './sign-in-letters';

/** How many messages an address may be sent in an hour (O-4: provisional). */
export const SIGN_IN_LINKS_PER_HOUR = 5;

/**
 * How many links one client address may ask for in an hour, whatever the addresses (D-138 §7): the
 * per-address limit stops one mailbox being flooded, this stops one client sending to many.
 */
export const SIGN_IN_REQUESTS_PER_HOUR = 20;

/** The address as it is stored and compared (D-40): trimmed, lower-cased, one mailbox. */
const signInAddress = (typed: string): string => {
  const address = normalisedMailbox(typed);
  if (address === undefined) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      message: 'That is not an email address.',
      details: { fields: { email: 'is not an email address' } },
    });
  }
  return address;
};

/**
 * An account GitHub made, which never signs in by link (D-138 §2). One made by email keeps its link
 * once GitHub is linked to it too: linking adds a way in and takes none away.
 */
export const madeByGitHub = (account: {
  readonly github_id: string | null;
  readonly github_connected_at: Date | null;
}): boolean => account.github_id !== null && account.github_connected_at === null;

/** What a request for an address comes to: a link, the word to use GitHub, or nothing at all. */
type Fate = 'link' | 'github' | 'nothing';

/**
 * Whether a link to `email` may sign somebody in, read now. Asked when a link is asked for and again
 * when it is shown and spent, since the account can change in between: become GitHub's, be erased.
 */
const fateOf = async (
  executor: Executor,
  clock: Clock,
  email: string,
  signUp: SignInLinks['signUp'],
): Promise<Fate> => {
  const account = await executor
    .selectFrom('users')
    .select(['github_id', 'github_connected_at', 'deleted_at', 'email_verified'])
    .where('email', '=', email)
    .executeTakeFirst();
  // No account: the link makes one, where anybody may (D-179 §5) — and, where only the invited may, for
  // an address holding a live passport made from an invitation link (R51). Asked of the address and of
  // nothing the asker sent, so it is the same answer to everybody else; the sign-up itself spends the
  // passport (`better-auth.ts`), so a link is as good as the passport is at the moment it is spent.
  if (account === undefined) {
    if (signUp === 'open') return 'link';
    return (await passportAllows(executor, clock, { email })) === undefined ? 'nothing' : 'link';
  }
  // An erased account keeps no address it could be reached by (D-27); one still holding it is not
  // signed into, nor told anything.
  if (account.deleted_at !== null) return 'nothing';
  // Its address never proven: the library would remove its password and end its sessions as it
  // signed in (D-179 §4). Nothing is sent, and the asker is answered as for any address.
  if (!account.email_verified) return 'nothing';
  return madeByGitHub(account) ? 'github' : 'link';
};

/** What a counter of ours is kept under in `rate_limits`: a purpose and a digest, never an address. */
const counterKey = async (what: 'address' | 'client', value: string): Promise<string> =>
  `purlay:sign-in-link:${what}:${await tokenDigest(value)}`;

/** The counter of an address's messages, which an erasure deletes with the rest of the person. */
export const addressCounterKey = async (email: string): Promise<string> =>
  await counterKey('address', email);

export interface SignInLinkDependencies {
  readonly database: Executor;
  readonly clock: Clock;
  readonly log: Logger;
  readonly appUrl: string;
  /** The sign-in library's links; absent where no relay is configured (D-138 §6). */
  readonly links: SignInLinks | undefined;
  /**
   * Where what a request comes to is left, to run after its answer (`platform/after-answer.ts`). A
   * request is answered once it is counted: the account is read, and a link made, only after.
   */
  readonly later: (work: () => Promise<void>) => void;
}

/**
 * A link to the address, if one may be sent: counted, answered, and only then decided and handed to the
 * library to make and mail (`sendMagicLink`, in `better-auth.ts`). Returns nothing either way, so its
 * caller's answer cannot say which it was — neither in what it says nor in how long it takes; past
 * either limit nothing is made or sent, and the log says so without the address.
 */
export const requestSignInLink = async (
  { database, clock, log, appUrl, links, later }: SignInLinkDependencies,
  input: EmailSignInRequest,
  client: string,
): Promise<void> => {
  if (links === undefined) {
    throw new AppError({
      code: 'EMAIL_SIGN_IN_UNAVAILABLE',
      message: 'This server does not sign in by email.',
    });
  }
  const email = signInAddress(input.email);
  const now = clock.now();
  // Before the answer, only what is the same for every address: the two counts, each one statement.
  if (
    (await counted(database, await counterKey('client', client), now, HOUR_MS)).count >
    SIGN_IN_REQUESTS_PER_HOUR
  ) {
    log.warn('sign-in link refused: the client has asked for its links for the hour');
    return;
  }
  // Every request for an address counts, whatever it comes to: neither a link nor the word about
  // GitHub can flood a mailbox, and an address that gets nothing costs what one that gets a link does.
  if (
    (await counted(database, await addressCounterKey(email), now, HOUR_MS)).count >
    SIGN_IN_LINKS_PER_HOUR
  ) {
    log.warn('sign-in link refused: the address has had its links for the hour');
    return;
  }
  // After the answer, what depends on the address: whether it has an account, and the link the library
  // makes for it — a row written and a message queued, which an answer that waited for them would time.
  later(async () => {
    const fate = await fateOf(database, clock, email, links.signUp);
    if (fate === 'link') {
      await links.issue(email, {
        locale: input.locale,
        ...(input.invitation === undefined ? {} : { invitation: input.invitation }),
      });
    } else if (fate === 'github') {
      links.outbox.post(githubLetter(email, input.locale, appUrl), 'sign-in');
    }
  });
};

/**
 * Where the library keeps a link: `magic-link:` and the token's SHA-256, base64url without padding —
 * its `storeToken: 'hashed'`, as measured on 1.7.12 (`magic-link.integration.test.ts`).
 */
const storedIdentifier = async (token: string): Promise<string> =>
  `magic-link:${Buffer.from(await tokenDigest(token), 'hex').toString('base64url')}`;

/** The address a link's row was made for, as the library wrote it — or nothing, for any other value. */
const addressOf = (value: string): string | undefined => {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const record = parsed as Readonly<Record<string, unknown>>;
    return record['type'] === 'magic-link' && typeof record['email'] === 'string'
      ? record['email']
      : undefined;
  } catch {
    return undefined;
  }
};

const linkNotFound = (): AppError =>
  new AppError({
    code: 'SIGN_IN_LINK_NOT_FOUND',
    message: 'That sign-in link does not open any more. Ask for another.',
  });

/**
 * The address a link was sent to, for the page to show before the person signs in (D-138 §4) — so a
 * link somebody forwarded from their own mailbox is seen to be theirs. Reads; spends nothing. Its
 * expiry is read against the system's clock, as the library reads it when the link is spent.
 */
export const previewSignInLink = async (
  { database, clock, links }: Pick<SignInLinkDependencies, 'database' | 'clock' | 'links'>,
  token: string,
): Promise<EmailSignInPreview> => {
  if (links === undefined) throw linkNotFound();
  const row = await database
    .selectFrom('verifications')
    .select('value')
    .where('identifier', '=', await storedIdentifier(token))
    .where('expires_at', '>', systemClock.now())
    .executeTakeFirst();
  const email = row === undefined ? undefined : addressOf(row.value);
  if (email === undefined || (await fateOf(database, clock, email, links.signUp)) !== 'link') {
    throw linkNotFound();
  }
  return { email };
};

/**
 * Spends a link and opens a session: the cookies to set. Shown first, by the same rules, so a link
 * whose account may not sign in by it is refused before the library is asked — which would spend it,
 * and for an account never proven, take its password with it.
 */
export const consumeSignInLink = async (
  dependencies: Pick<SignInLinkDependencies, 'database' | 'clock' | 'links'>,
  token: string,
  headers: Headers,
): Promise<{ readonly setCookie: readonly string[] }> => {
  await previewSignInLink(dependencies, token);
  const setCookie = await dependencies.links?.spend(token, headers);
  if (setCookie === undefined) throw linkNotFound();
  return { setCookie };
};
