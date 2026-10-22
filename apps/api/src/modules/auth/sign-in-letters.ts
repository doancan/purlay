/**
 * The two messages signing in by email sends (D-138 §2, §4): a link, and — to the address of an
 * account GitHub made — a word to sign in with GitHub instead. In the language the person asked in
 * (D-41), plain text, and the same as HTML with the one address made a link.
 */
import { SIGN_IN_LINK_TTL_MINUTES, type EmailSignInRequest } from '@purlay/types';
import { textLetter, type MailMessage } from '../../platform/mail';

export type SignInLocale = EmailSignInRequest['locale'];

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

/** A sign-in link: `url` is the page the link opens, its token in the fragment (D-138 §4). */
export const linkLetter = (to: string, locale: SignInLocale, url: string): MailMessage =>
  textLetter(to, WORDS[locale].linkSubject, WORDS[locale].link(url), url);

/** The word to an account GitHub made: no link, and the way it does sign in (D-138 §2). */
export const githubLetter = (to: string, locale: SignInLocale, appUrl: string): MailMessage =>
  textLetter(to, WORDS[locale].githubSubject, WORDS[locale].github(appUrl), appUrl);
