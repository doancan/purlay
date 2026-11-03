/**
 * The messages signing in by email sends (D-138 §2, §4): a link, and — to the address of an
 * account GitHub or Google made — a word to sign in with that provider instead (D-251). In the language
 * the person asked in (D-41), as a letter (`composeLetter`): a short note and one button.
 */
import { SIGN_IN_LINK_TTL_MINUTES, type EmailSignInRequest } from '@purlay/types';
import { composeLetter } from '../../platform/letter';
import type { MailMessage } from '../../platform/mail';

export type SignInLocale = EmailSignInRequest['locale'];

const MINUTES = String(SIGN_IN_LINK_TTL_MINUTES);

const WORDS = {
  en: {
    linkSubject: 'Your sign-in link for Purlay',
    link: `Use the button below to sign in to Purlay. It works once, for ${MINUTES} minutes.`,
    linkButton: 'Sign in to Purlay',
    linkIgnore:
      'If you did not ask for it, you can ignore this email: nobody can use the link without this mailbox.',
    providerSubject: 'Signing in to Purlay',
    provider: (name: string): string =>
      `Somebody asked to sign in to Purlay with this address. It belongs to an account that signs in with ${name}, ` +
      `so no link was sent: use “Continue with ${name}” on the sign-in page.`,
    providerButton: 'Open Purlay',
    providerIgnore: 'If it was not you, you can ignore this email.',
  },
  tr: {
    linkSubject: 'Purlay giriş bağlantın',
    link: `Purlay’a girmek için aşağıdaki düğmeye bas. Bağlantı bir kez ve ${MINUTES} dakika boyunca çalışır.`,
    linkButton: 'Purlay’a gir',
    linkIgnore:
      'Sen istemediysen bu e-postayı görmezden gelebilirsin: bu posta kutusu olmadan bağlantıyı kimse kullanamaz.',
    providerSubject: 'Purlay’a giriş',
    provider: (name: string): string =>
      `Biri bu adresle Purlay’a girmek istedi. Bu adres ${name} ile giriş yapan bir hesaba ait, ` +
      `bu yüzden bağlantı gönderilmedi: giriş sayfasında “${name} ile devam et” düğmesini kullan.`,
    providerButton: 'Purlay’ı aç',
    providerIgnore: 'Sen değilsen bu e-postayı görmezden gelebilirsin.',
  },
} as const;

/** A sign-in link: `url` is the page the link opens, its token in the fragment (D-138 §4). */
export const linkLetter = (to: string, locale: SignInLocale, url: string): MailMessage => {
  const words = WORDS[locale];
  return composeLetter({
    to,
    subject: words.linkSubject,
    locale,
    blocks: [
      { kind: 'paragraph', text: words.link },
      { kind: 'button', label: words.linkButton, url },
      { kind: 'note', text: words.linkIgnore },
    ],
  });
};

/** The word to an account a provider made: no link, and the way it does sign in. */
const providerLetter = (
  name: 'GitHub' | 'Google',
  to: string,
  locale: SignInLocale,
  appUrl: string,
): MailMessage => {
  const words = WORDS[locale];
  return composeLetter({
    to,
    subject: words.providerSubject,
    locale,
    blocks: [
      { kind: 'paragraph', text: words.provider(name) },
      { kind: 'button', label: words.providerButton, url: appUrl },
      { kind: 'note', text: words.providerIgnore },
    ],
  });
};

/** The word to an account GitHub made: no link, and the way it does sign in (D-138 §2). */
export const githubLetter = (to: string, locale: SignInLocale, appUrl: string): MailMessage =>
  providerLetter('GitHub', to, locale, appUrl);

/** The word to an account Google made: no link, and the way it does sign in (D-251). */
export const googleLetter = (to: string, locale: SignInLocale, appUrl: string): MailMessage =>
  providerLetter('Google', to, locale, appUrl);
