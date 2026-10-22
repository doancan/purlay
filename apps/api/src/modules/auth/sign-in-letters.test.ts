import { describe, expect, test } from 'bun:test';
import { SIGN_IN_LINK_TTL_MINUTES } from '@purlay/types';
import { githubLetter, linkLetter } from './sign-in-letters';

const URL_OPENED = 'https://purlay.test/sign-in/email#token';

describe('the sign-in link letter', () => {
  test('carries the link and how long it works, in each language', () => {
    const en = linkLetter('a@example.test', 'en', URL_OPENED);
    expect(en.to).toBe('a@example.test');
    expect(en.subject).toBe('Your sign-in link for Purlay');
    expect(en.text).toContain(URL_OPENED);
    expect(en.text).toContain(`for ${String(SIGN_IN_LINK_TTL_MINUTES)} minutes`);
    const tr = linkLetter('a@example.test', 'tr', URL_OPENED);
    expect(tr.subject).toBe('Purlay giriş bağlantın');
    expect(tr.text).toContain(URL_OPENED);
    expect(tr.text).toContain(`${String(SIGN_IN_LINK_TTL_MINUTES)} dakika`);
  });
});

describe('the word to an account GitHub made', () => {
  test('has no link to sign in, and points to GitHub at the server’s address, in English', () => {
    const letter = githubLetter('a@example.test', 'en', 'https://purlay.test');
    expect(letter.subject).toBe('Signing in to Purlay');
    expect(letter.text).toContain('“Continue with GitHub” at https://purlay.test');
    expect(letter.text).not.toContain('#');
  });

  test('says the same in Turkish', () => {
    const letter = githubLetter('a@example.test', 'tr', 'https://purlay.test');
    expect(letter.subject).toBe('Purlay’a giriş');
    expect(letter.text).toContain('https://purlay.test adresinde “GitHub ile devam et”');
  });
});
