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
import { sql, type Transaction } from '@purlay/db';
import type { EmailSignInRequest } from '@purlay/types';
import type { Clock } from '../../platform/clock';
import { AppError } from '../../platform/errors';
import type { Logger } from '../../platform/logging';
import type { MailMessage } from '../../platform/mail';
import { randomToken, tokenDigest } from '../../platform/tokens';

/** How long a link opens. */
export const SIGN_IN_LINK_TTL_MS = 15 * 60_000;
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
      `Open this link to sign in to Purlay. It works once, for fifteen minutes:\n\n${url}\n\n` +
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
      `Purlay’a girmek için bu bağlantıyı aç. Bir kez ve on beş dakika boyunca çalışır:\n\n${url}\n\n` +
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
    .select(['github_id', 'deleted_at'])
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
  if (account?.github_id != null) {
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
  const url = `${appUrl}/sign-in/email#${token}`;
  return message(email, words.linkSubject, words.link(url), url);
};
