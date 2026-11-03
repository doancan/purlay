import { describe, expect, test } from 'bun:test';
import { SIGN_IN_LINK_TTL_MINUTES } from '@purlay/types';
import { githubLetter, googleLetter, linkLetter } from './sign-in-letters';

const URL_OPENED = 'https://purlay.test/sign-in/email#token';

describe('the sign-in link letter', () => {
  test('carries the link as its button and how long it works, in each language', () => {
    const en = linkLetter('a@example.test', 'en', URL_OPENED);
    expect(en.to).toBe('a@example.test');
    expect(en.subject).toBe('Your sign-in link for Purlay');
    expect(en.text).toContain(`Sign in to Purlay:\n${URL_OPENED}`);
    expect(en.text).toContain(`for ${String(SIGN_IN_LINK_TTL_MINUTES)} minutes`);
    expect(en.html).toContain(`href="${URL_OPENED}"`);
    expect(en.html).toContain('>Sign in to Purlay</a>');
    const tr = linkLetter('a@example.test', 'tr', URL_OPENED);
    expect(tr.subject).toBe('Purlay giriş bağlantın');
    expect(tr.text).toContain(`Purlay’a gir:\n${URL_OPENED}`);
    expect(tr.text).toContain(`${String(SIGN_IN_LINK_TTL_MINUTES)} dakika`);
    expect(tr.html).toContain('<html lang="tr">');
  });
});

describe('the word to an account GitHub made', () => {
  test('has no link to sign in, and points to GitHub and the server’s address, in English', () => {
    const letter = githubLetter('a@example.test', 'en', 'https://purlay.test');
    expect(letter.subject).toBe('Signing in to Purlay');
    expect(letter.text).toContain('use “Continue with GitHub” on the sign-in page');
    expect(letter.text).toContain('Open Purlay:\nhttps://purlay.test');
    expect(letter.text).not.toContain('#');
  });

  test('says the same in Turkish', () => {
    const letter = githubLetter('a@example.test', 'tr', 'https://purlay.test');
    expect(letter.subject).toBe('Purlay’a giriş');
    expect(letter.text).toContain('“GitHub ile devam et” düğmesini kullan');
    expect(letter.text).toContain('Purlay’ı aç:\nhttps://purlay.test');
  });
});

describe('the word to an account Google made', () => {
  test('has no link to sign in, and points to Google and the server’s address, in English', () => {
    const letter = googleLetter('a@example.test', 'en', 'https://purlay.test');
    expect(letter.to).toBe('a@example.test');
    expect(letter.subject).toBe('Signing in to Purlay');
    expect(letter.text).toContain('use “Continue with Google” on the sign-in page');
    expect(letter.text).toContain('Open Purlay:\nhttps://purlay.test');
    expect(letter.text).not.toContain('#');
  });

  test('says the same in Turkish', () => {
    const letter = googleLetter('a@example.test', 'tr', 'https://purlay.test');
    expect(letter.subject).toBe('Purlay’a giriş');
    expect(letter.text).toContain('“Google ile devam et” düğmesini kullan');
  });
});
