/**
 * Asking for a sign-in link by email (#81, D-138).
 *
 * - **The same answer whatever the address** (§1): this decides what to send, and the caller answers
 *   `202` without waiting for it. Whether an account has the address is never said.
 * - **Email sign-in is for accounts made by email** (§2): an address of an account made with GitHub is
 *   told to sign in with GitHub, and gets no link. An address no account has gets a link that will
 *   make one on its use; an email account's gets a link into it.
 * - **The token is the platform's** (`platform/tokens.ts`): only its digest is stored, it lives fifteen
 *   minutes, and the link carries it in the fragment (§4), which no request line and no scanner sees.
 * - **Five messages an hour for an address** (§7, provisional), a link or a word about GitHub alike:
 *   past it nothing is made or sent, and the log says so without the address.
 */
import { sql, type Executor, type Transaction } from '@purlay/db';
import { SIGN_IN_LINK_TTL_MINUTES, type EmailSignInRequest } from '@purlay/types';
import type { Clock } from '../../platform/clock';
import { AppError } from '../../platform/errors';
import type { Logger } from '../../platform/logging';
import type { MailMessage } from '../../platform/mail';
import { randomToken, tokenDigest } from '../../platform/tokens';
import { BROADCAST_NAMES } from '@purlay/markdown';
import { availableUsername, livingName } from './identity';

/** How long a link opens. */
export const SIGN_IN_LINK_TTL_MS = SIGN_IN_LINK_TTL_MINUTES * 60_000;
/** How many links an address may be sent in an hour (O-4: provisional). */
export const SIGN_IN_LINKS_PER_HOUR = 5;

/**
 * An address and nothing else: dot-separated atoms before the `@`, dotted labels after it, ASCII only.
 * A looser check let `x<victim@example.com>` and `victim@example.com,x` through — strings a mail library
 * delivers to one mailbox while each is its own row to count, and none matches the account holding the
 * mailbox (D-138 §7). A control character can never pass, so nothing typed can make a header.
 */
const ATOM = "[a-z0-9!#$%&'*+/=?^_`{|}~-]+";
const LABEL = '[a-z0-9](?:[a-z0-9-]*[a-z0-9])?';
const ADDRESS = new RegExp(`^${ATOM}(?:\\.${ATOM})*@${LABEL}(?:\\.${LABEL})+$`);

/** The address as it is stored and compared (D-40): trimmed, lower-cased, one mailbox. */
const signInAddress = (typed: string): string => {
  const address = typed.trim().toLowerCase();
  if (!ADDRESS.test(address)) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      message: 'That is not an email address.',
      details: { fields: { email: 'is not an email address' } },
    });
  }
  return address;
};

/** The words of each message, in the language the person asked in (D-41). */
const WORDS = {
  en: {
    linkSubject: 'Your sign-in link for Purlay',
    link: (url: string): string =>
      `Open this link to sign in to Purlay. It works once, for ${String(SIGN_IN_LINK_TTL_MINUTES)} minutes:\n\n${url}\n\n` +
      'If you did not ask for it, nobody can use it without this mailbox; you can ignore it.',
    githubSubject: 'Signing in to Purlay',
    github: (url: string): string =>
      'Somebody asked to sign in to Purlay with this address. It belongs to an account that signs ' +
      `in with GitHub — use “Continue with GitHub” at ${url}.\n\n` +
      'If it was not you, you can ignore this message.',
  },
  tr: {
    linkSubject: 'Purlay giriş bağlantın',
    link: (url: string): string =>
      `Purlay’a girmek için bu bağlantıyı aç. Bir kez ve ${String(SIGN_IN_LINK_TTL_MINUTES)} dakika boyunca çalışır:\n\n${url}\n\n` +
      'Sen istemediysen, bu posta kutusu olmadan kimse kullanamaz; görmezden gelebilirsin.',
    githubSubject: 'Purlay’a giriş',
    github: (url: string): string =>
      'Biri bu adresle Purlay’a girmek istedi. Bu adres GitHub ile giriş yapan bir hesaba ait — ' +
      `${url} adresinde “GitHub ile devam et” düğmesini kullan.\n\nSen değilsen bu mesajı görmezden gelebilirsin.`,
  },
} as const;

const escape = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Plain text, and the same as HTML with the one address made a link. */
const message = (to: string, subject: string, text: string, url: string): MailMessage => ({
  to,
  subject,
  text,
  html: `<p>${escape(text)
    .replace(escape(url), `<a href="${escape(url)}">${escape(url)}</a>`)
    .replace(/\n\n/g, '</p><p>')}</p>`,
});

/**
 * What to send for this request, made now and sent after the answer — or nothing, past the limit.
 * Called inside the request's transaction, so the link's row commits before it is mailed.
 */
export const requestSignInLink = async (
  executor: Transaction,
  { clock, appUrl, log }: { readonly clock: Clock; readonly appUrl: string; readonly log: Logger },
  input: EmailSignInRequest,
): Promise<MailMessage | null> => {
  const email = signInAddress(input.email);
  const words = WORDS[input.locale];
  const now = clock.now();
  // One request for an address at a time: two at once would each count four and each send the fifth.
  await sql`select pg_advisory_xact_lock(hashtextextended(${`email-sign-in:${email}`}, 0))`.execute(
    executor,
  );
  const account = await executor
    .selectFrom('users')
    .select(['github_id', 'github_connected_at', 'deleted_at'])
    .where('email', '=', email)
    .executeTakeFirst();
  // Every message counts — a link or a word about GitHub — so neither can flood a mailbox. Counted
  // for every address, so how long the answer takes does not tell an erased one from the rest.
  const recent = await executor
    .selectFrom('email_sign_ins')
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .where('email', '=', email)
    .where('created_at', '>', new Date(now.getTime() - 60 * 60_000))
    .executeTakeFirstOrThrow();
  // An erased account keeps no address it could be reached by (D-27); one still holding it is not
  // signed into, nor told anything.
  if (account?.deleted_at != null) return null;
  if (Number(recent.count) >= SIGN_IN_LINKS_PER_HOUR) {
    log.warn('sign-in link refused: the address has had its links for the hour');
    return null;
  }
  const sent = {
    email,
    created_at: now,
    expires_at: new Date(now.getTime() + SIGN_IN_LINK_TTL_MS),
  };
  if (account !== undefined && madeByGitHub(account)) {
    await executor
      .insertInto('email_sign_ins')
      .values({ ...sent, kind: 'github', token_hash: null })
      .execute();
    return message(email, words.githubSubject, words.github(appUrl), appUrl);
  }
  const token = randomToken();
  await executor
    .insertInto('email_sign_ins')
    .values({
      ...sent,
      kind: 'link',
      token_hash: await tokenDigest(token),
    })
    .execute();
  // The fragment is `<token>` or `<token>.<invitation>`: neither reaches a server's log (§4).
  const url = `${appUrl}/sign-in/email#${token}${input.invitation === undefined ? '' : `.${input.invitation}`}`;
  return message(email, words.linkSubject, words.link(url), url);
};

const linkNotFound = (): AppError =>
  new AppError({
    code: 'SIGN_IN_LINK_NOT_FOUND',
    message: 'That sign-in link does not open any more. Ask for another.',
  });

/**
 * The address a link was sent to, for the page to show before the person signs in (D-138 §4) — so a
 * link somebody forwarded from their own mailbox is seen to be theirs. Reads; spends nothing.
 */
export const previewSignInLink = async (
  executor: Executor,
  clock: Clock,
  token: string,
): Promise<{ readonly email: string }> => {
  const row = await executor
    .selectFrom('email_sign_ins')
    .select('email')
    .where('token_hash', '=', await tokenDigest(token))
    .where('kind', '=', 'link')
    .where('used_at', 'is', null)
    .where('expires_at', '>', clock.now())
    .executeTakeFirst();
  if (row === undefined) throw linkNotFound();
  return { email: row.email };
};

/**
 * A username from an address's local part (D-138 §5): what a mention can name — lower-case letters,
 * digits and single hyphens between them — never a broadcast name; `null` when nothing is left. The
 * address is ASCII already (`signInAddress`), so there are no marked letters to keep.
 */
export const usernameFrom = (email: string): string | null => {
  const local = email.slice(0, email.lastIndexOf('@'));
  const shaped = local
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 39)
    .replace(/-+$/, '');
  return shaped === '' || BROADCAST_NAMES.has(shaped) ? null : shaped;
};

/**
 * Spends a link and answers whose session to open (D-138 §2, §4): once, within its fifteen minutes —
 * the one statement that checks it is unspent sets it spent. An address no account has is made an
 * account; an email account's is signed into; a GitHub account's, or an erased one's, never — the
 * same `SIGN_IN_LINK_NOT_FOUND` as a spent link, and the caller's transaction undoes the spend.
 * Writes more than once, so it takes the transaction that makes them one (D-77).
 */
export const consumeSignInLink = async (
  executor: Transaction,
  clock: Clock,
  token: string,
): Promise<{ readonly userId: string; readonly created: boolean }> => {
  const now = clock.now();
  const spent = await executor
    .updateTable('email_sign_ins')
    .set({ used_at: now })
    .where('token_hash', '=', await tokenDigest(token))
    .where('kind', '=', 'link')
    .where('used_at', 'is', null)
    .where('expires_at', '>', now)
    .returning('email')
    .executeTakeFirst();
  if (spent === undefined) throw linkNotFound();
  const account = await accountOf(executor, spent.email);
  if (account !== undefined) {
    if (madeByGitHub(account) || account.deleted_at !== null) throw linkNotFound();
    return { userId: account.id, created: false };
  }
  // Nothing to make a name of: a random one, not `user-1` … `user-99`, which a hundred such
  // addresses would use up for good.
  const wanted = usernameFrom(spent.email) ?? `user-${randomToken().slice(0, 6)}`;
  const username = await availableUsername(executor, livingName(wanted), undefined);
  // Two links to one new address used at once both reach here, both wanting the same name: the
  // insert does nothing on whichever key it meets first — the address or the name, Postgres decides
  // — and the account is read back by its address: one account, whichever made it (D-78).
  await executor
    .insertInto('users')
    .values({
      email: spent.email,
      username,
      display_name: username,
      created_at: now,
      updated_at: now,
    })
    .onConflict((conflict) => conflict.doNothing())
    .execute();
  const made = await accountOf(executor, spent.email);
  if (made === undefined) {
    // No account has the address, so what refused the insert was the name: another new address
    // took it at the same instant. Loud — a 500, logged with this sentence — and the spend is undone
    // with the rest, so pressing again makes the account under the next name.
    throw new Error('sign-in by link: the username was taken at the same instant');
  }
  // The other link's account, made a moment ago — by email, or since, by GitHub (§2).
  if (madeByGitHub(made) || made.deleted_at !== null) throw linkNotFound();
  return { userId: made.id, created: true };
};

/**
 * An account GitHub made, which never signs in by link (D-138 §2). One made by email keeps its link
 * once it has connected GitHub too (D-176): connecting adds a way in and takes none away.
 */
export const madeByGitHub = (account: {
  readonly github_id: string | null;
  readonly github_connected_at: Date | null;
}): boolean => account.github_id !== null && account.github_connected_at === null;

const accountOf = async (
  executor: Executor,
  email: string,
): Promise<
  | {
      readonly id: string;
      readonly github_id: string | null;
      readonly github_connected_at: Date | null;
      readonly deleted_at: Date | null;
    }
  | undefined
> =>
  await executor
    .selectFrom('users')
    .select(['id', 'github_id', 'github_connected_at', 'deleted_at'])
    .where('email', '=', email)
    .executeTakeFirst();
