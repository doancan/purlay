/**
 * The administrator's verification letter (D-179 §4.3): plain words in the sign-in letter's register,
 * naming the server it is for, its link with the token in the fragment, and what to do if it was not
 * expected.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { adminVerificationLetter, relayTestLetter } from './verification';

const TOKEN = 'a'.repeat(64);

describe('the administrator’s verification letter', () => {
  test('names the server, carries the link with its token in the fragment, and says to ignore it if unexpected', () => {
    const letter = adminVerificationLetter({
      to: 'ada@example.com',
      appUrl: 'https://chat.example.com',
      token: TOKEN,
      locale: 'en',
    });
    expect(letter.to).toBe('ada@example.com');
    expect(letter.subject).toBe('Confirm your address for Purlay');
    expect(letter.text).toContain('https://chat.example.com');
    expect(letter.text).toContain(`https://chat.example.com/setup/verify#${TOKEN}`);
    expect(letter.text).toContain('24 hours');
    expect(letter.text).toContain('you can ignore');
    // Never in the path or the query, where a log or a referrer would carry it (D-138 §4).
    expect(letter.text).not.toContain(`/setup/verify/${TOKEN}`);
    expect(letter.text).not.toContain(`?token=`);
    expect(letter.html).toContain(`<a href="https://chat.example.com/setup/verify#${TOKEN}">`);
  });

  test('is in Turkish for a Turkish wizard', () => {
    const letter = adminVerificationLetter({
      to: 'ada@example.com',
      appUrl: 'https://chat.example.com',
      token: TOKEN,
      locale: 'tr',
    });
    expect(letter.subject).toBe('Purlay için adresini doğrula');
    expect(letter.text).toContain('24 saat');
    expect(letter.text).toContain(`https://chat.example.com/setup/verify#${TOKEN}`);
  });

  test('an address with a path or a trailing slash still makes one link', () => {
    const letter = adminVerificationLetter({
      to: 'ada@example.com',
      appUrl: 'https://chat.example.com/',
      token: TOKEN,
      locale: 'en',
    });
    expect(letter.text).toContain(`https://chat.example.com/setup/verify#${TOKEN}`);
  });
});

describe('a presented link against the stored digest', () => {
  test('is compared only by `digestsEqual`, in constant time — never by `===`', () => {
    const source = readFileSync(join(import.meta.dir, 'verification.ts'), 'utf8');
    expect(source).not.toMatch(/(?:presented|token_digest)\s*[!=]==(?!\s*null\b)/);
    expect(source).not.toMatch(/[!=]==\s*(?:presented|\w+\.token_digest)/);
    expect(source.match(/digestsEqual\(/g)).toHaveLength(1);
  });
});

describe('the letter a relay is tried with when the address is verified already', () => {
  test('names the server by its origin, in English, with nothing to open', () => {
    const letter = relayTestLetter({
      to: 'admin@example.test',
      appUrl: 'https://purlay.test/some/path',
      locale: 'en',
    });
    expect(letter.to).toBe('admin@example.test');
    expect(letter.subject).toBe('A test from your Purlay server');
    expect(letter.text).toContain('the Purlay server at https://purlay.test: its mail works');
    expect(letter.text).not.toContain('/some/path');
  });

  test('says the same in Turkish', () => {
    const letter = relayTestLetter({
      to: 'admin@example.test',
      appUrl: 'https://purlay.test',
      locale: 'tr',
    });
    expect(letter.subject).toBe('Purlay sunucundan bir deneme');
    expect(letter.text).toContain('https://purlay.test adresindeki Purlay sunucusundan');
    expect(letter.html).toContain('https://purlay.test');
  });
});
