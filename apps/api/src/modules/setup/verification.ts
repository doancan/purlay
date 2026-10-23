/**
 * The setup administrator's own address check (D-179 §4.3, Ruling R32): one link the wizard mails to
 * the administrator — in its e-mail step, as the letter the relay is tried with (Ruling R47) — whose
 * following marks the address verified. Over one row, `admin_email_verification` (migration 0051).
 *
 * - **Never the library's magic link.** On an account whose address was never proven, the library's
 *   link removes the password and ends the sessions (D-179 §4.3, measured), and the administrator's is
 *   exactly such an account; this link only sets `users.email_verified`.
 * - **Issued under the claim** (`heldBy`, under the row's lock), for the administrator the setup made,
 *   while the address is unverified; a new link replaces the one before it. The token is 256 bits
 *   (`platform/tokens.ts`), handed back once for the letter and kept only as its digest; the link
 *   carries it in the fragment (`/setup/verify#<token>`), so no request line or referrer does.
 * - **Followed by anyone holding it, for a day, once.** The row names the account itself, so the link
 *   still opens after *Finish* has forgotten the administrator and spent the claim, and in a browser
 *   that never held it. The token is compared with the digest in constant time; it is spent — the row
 *   deleted — in the transaction that marks the address; an unknown, spent, expired or wrong link, or
 *   one whose account was erased, is the one refusal.
 */
import type { Executor } from '@purlay/db';
import { DAY_MS, type Clock } from '../../platform/clock';
import { textLetter, type MailMessage } from '../../platform/mail';
import { atomicallyOn } from '../../platform/transactions';
import { digestsEqual, randomToken, tokenDigest } from '../../platform/tokens';
import type { SignInLocale } from '../auth/sign-in-letters';
import { heldBy, SetupRefused, type SetupClaimDigest } from './setup';

/** How long a link opens from its issue. */
export const ADMIN_VERIFICATION_TTL_MS = DAY_MS;

const TTL_HOURS = ADMIN_VERIFICATION_TTL_MS / (60 * 60 * 1000);

/** The page the link opens; the token follows in the fragment. */
const VERIFY_PATH = '/setup/verify';

/** Why a link was not issued, beyond the claim's own refusals (`SetupRefused`). */
export type VerificationRefusal =
  { readonly reason: 'no-admin' } | { readonly reason: 'already-verified' };

const SENTENCES: Record<VerificationRefusal['reason'], string> = {
  'no-admin': 'This setup has no administrator to verify yet.',
  'already-verified': 'The administrator’s address is verified already.',
};

export class VerificationRefused extends Error {
  readonly refusal: VerificationRefusal;

  constructor(refusal: VerificationRefusal) {
    super(SENTENCES[refusal.reason]);
    this.name = 'VerificationRefused';
    this.refusal = refusal;
  }
}

/** A digest no token has, compared with when there is no row: the same work either way. */
const NO_DIGEST = '0'.repeat(64);

/**
 * A link for the setup's administrator, replacing any before it: the token, for the letter alone, and
 * the address it goes to. Under the session's claim.
 */
export const issueAdminVerification = async (
  executor: Executor,
  session: SetupClaimDigest,
  { clock }: { readonly clock: Clock },
): Promise<IssuedVerification> => {
  const token = randomToken();
  const digest = await tokenDigest(token);
  const outcome = await atomicallyOn(executor)(async (transaction) => {
    const state = await heldBy(transaction, session);
    if ('reason' in state) return state;
    if (state.admin_user_id === null) return { reason: 'no-admin' as const };
    const admin = await transaction
      .selectFrom('users')
      .select(['email', 'email_verified'])
      .where('id', '=', state.admin_user_id)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (admin === undefined) return { reason: 'no-admin' as const };
    if (admin.email_verified) return { reason: 'already-verified' as const };
    // Read under the lock this transaction holds on the claim's row, in the same transaction that replaces
    // it: what a letter that then fails puts back is what was in force at this moment, not at some earlier one.
    const previous = await transaction
      .selectFrom('admin_email_verification')
      .select(['user_id', 'email', 'token_digest', 'issued_at'])
      .where('id', '=', true)
      .forUpdate()
      .executeTakeFirst();
    const row = {
      user_id: state.admin_user_id,
      email: admin.email,
      token_digest: digest,
      issued_at: clock.now(),
    };
    // The one row: whatever link was there before is replaced, and stops opening.
    await transaction
      .insertInto('admin_email_verification')
      .values({ id: true, ...row })
      .onConflict((conflict) => conflict.column('id').doUpdateSet(row))
      .execute();
    return { email: admin.email, previous };
  });
  if ('email' in outcome) {
    return { token, email: outcome.email, digest, previous: outcome.previous };
  }
  if (outcome.reason === 'no-admin' || outcome.reason === 'already-verified') {
    throw new VerificationRefused(outcome);
  }
  throw new SetupRefused(outcome);
};

/** The one row as it is kept: whose address, which mailbox, the link's digest and its day. */
export interface AdminVerificationRow {
  readonly user_id: string;
  readonly email: string;
  readonly token_digest: string;
  readonly issued_at: Date;
}

/**
 * What an issue hands back: the token for the letter alone, the address it goes to, the digest the row
 * now holds, and the link it replaced — which a letter that then fails puts back (`restoreAdminVerification`).
 */
export interface IssuedVerification {
  readonly token: string;
  readonly email: string;
  readonly digest: string;
  readonly previous: AdminVerificationRow | undefined;
}

/**
 * Puts back the link a letter replaced and never carried — **only while the row still holds the link that
 * letter issued** (`replacedDigest`). A later issue took the row since (two sends at once), or the link was
 * followed and spent: then there is nothing of this letter's to undo, and what is there is not touched.
 */
export const restoreAdminVerification = async (
  executor: Executor,
  previous: AdminVerificationRow,
  replacedDigest: string,
): Promise<void> => {
  await executor
    .updateTable('admin_email_verification')
    .set({
      user_id: previous.user_id,
      email: previous.email,
      token_digest: previous.token_digest,
      issued_at: previous.issued_at,
    })
    .where('id', '=', true)
    .where('token_digest', '=', replacedDigest)
    .execute();
};

/**
 * A link followed: the administrator's address verified and the link spent, in one transaction — or
 * `refused`, the same for every way of failing, so nothing tells a wrong link from a spent one.
 */
export const verifyAdminEmail = async (
  executor: Executor,
  token: string,
  clock: Clock,
): Promise<'verified' | 'refused'> => {
  const presented = await tokenDigest(token);
  const now = clock.now();
  return await atomicallyOn(executor)(async (transaction) => {
    const row = await transaction
      .selectFrom('admin_email_verification')
      .select(['user_id', 'email', 'token_digest', 'issued_at'])
      .where('id', '=', true)
      .forUpdate()
      .executeTakeFirst();
    const matches = digestsEqual(presented, row?.token_digest ?? NO_DIGEST);
    // An issue "in the future" is a clock moved back: the link is not trusted to be within its day.
    const age = row === undefined ? -1 : now.getTime() - row.issued_at.getTime();
    if (row === undefined || !matches) return 'refused';
    if (age < 0 || age >= ADMIN_VERIFICATION_TTL_MS) {
      // Past its day — and, issued "in the future", untrusted — it is nothing worth keeping.
      await transaction.deleteFrom('admin_email_verification').where('id', '=', true).execute();
      return 'refused';
    }
    // The one who deletes the row is the one who may mark the address: the lock above makes a second
    // click wait and then find nothing, and this holds without it.
    const spent = await transaction
      .deleteFrom('admin_email_verification')
      .where('id', '=', true)
      .where('token_digest', '=', row.token_digest)
      .executeTakeFirst();
    if (spent.numDeletedRows !== 1n) return 'refused';
    const marked = await transaction
      .updateTable('users')
      .set({ email_verified: true, updated_at: now })
      .where('id', '=', row.user_id)
      .where('deleted_at', 'is', null)
      // The address the link was mailed to: changed since, the link proves the old mailbox only.
      .where('email', '=', row.email)
      .executeTakeFirst();
    return marked.numUpdatedRows === 1n ? 'verified' : 'refused';
  });
};

const WORDS = {
  en: {
    subject: 'Confirm your address for Purlay',
    text: (appUrl: string, url: string): string =>
      `You are setting up the Purlay server at ${appUrl}, with this address as its administrator's. ` +
      `Open this link to confirm the address is yours. It works once, for ${String(TTL_HOURS)} hours:\n\n${url}\n\n` +
      'If you are not setting up a Purlay server, you can ignore this message; nothing changes without the link.',
  },
  tr: {
    subject: 'Purlay için adresini doğrula',
    text: (appUrl: string, url: string): string =>
      `${appUrl} adresindeki Purlay sunucusunu kuruyorsun; yöneticinin adresi bu. ` +
      `Adresin senin olduğunu doğrulamak için bu bağlantıyı aç. Bir kez ve ${String(TTL_HOURS)} saat boyunca çalışır:\n\n${url}\n\n` +
      'Bir Purlay sunucusu kurmuyorsan bu mesajı görmezden gelebilirsin; bağlantı olmadan hiçbir şey değişmez.',
  },
} as const;

/** The letter that carries the link, for the probe to send (`probeSmtp`) or an outbox to post. */
export const adminVerificationLetter = ({
  to,
  appUrl,
  token,
  locale,
}: {
  readonly to: string;
  /** The server's address (`APP_URL`), named in the letter and the link's base. */
  readonly appUrl: string;
  readonly token: string;
  readonly locale: SignInLocale;
}): MailMessage => {
  const link = new URL(VERIFY_PATH, appUrl);
  link.hash = token;
  const server = new URL(appUrl).origin;
  return textLetter(
    to,
    WORDS[locale].subject,
    WORDS[locale].text(server, link.toString()),
    link.toString(),
  );
};

const TEST_WORDS = {
  en: {
    subject: 'A test from your Purlay server',
    text: (appUrl: string): string =>
      `This is a test from the Purlay server at ${appUrl}: its mail works. Your address is verified already, so there is nothing to do.\n\n${appUrl}`,
  },
  tr: {
    subject: 'Purlay sunucundan bir deneme',
    text: (appUrl: string): string =>
      `Bu, ${appUrl} adresindeki Purlay sunucusundan bir deneme: e-postası çalışıyor. Adresin zaten doğrulanmış, yapacak bir şey yok.\n\n${appUrl}`,
  },
} as const;

/**
 * The letter a relay is tried with when the administrator's address is verified already (D-179 §4.4):
 * there is no link to send, and a try still needs a letter — so a plain one, naming the server.
 */
export const relayTestLetter = ({
  to,
  appUrl,
  locale,
}: {
  readonly to: string;
  readonly appUrl: string;
  readonly locale: SignInLocale;
}): MailMessage => {
  const server = new URL(appUrl).origin;
  return textLetter(to, TEST_WORDS[locale].subject, TEST_WORDS[locale].text(server), server);
};

/**
 * A link past its day, deleted: by the daily sweep (`sweepEmailSignIns`), so a link nobody followed or
 * replaced is not kept for ever. The number deleted, none or one.
 */
export const sweepAdminVerification = async (executor: Executor, clock: Clock): Promise<number> => {
  const deleted = await executor
    .deleteFrom('admin_email_verification')
    .where('issued_at', '<=', new Date(clock.now().getTime() - ADMIN_VERIFICATION_TTL_MS))
    .executeTakeFirst();
  return Number(deleted.numDeletedRows);
};
