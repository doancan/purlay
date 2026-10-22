/**
 * The letter an invitation is sent in (D-179 §5): what it says, and that nothing a person typed can
 * make a header, a line of its own, or a link of its own.
 */
import { describe, expect, test } from 'bun:test';
import { invitationLetter, quotable, type Letterhead } from './invitation-mail';

const TOKEN = 'c'.repeat(64);
const head = (over: Partial<Letterhead> = {}): Letterhead => ({
  inviter: 'Alice Doe',
  workspace: 'Acme',
  expiresAt: '2026-10-28T09:30:00.000Z',
  url: `https://purlay.test/invite#${TOKEN}`,
  locale: 'en',
  ...over,
});

describe('the invitation letter', () => {
  test('says who invited, to what, the link with its token in the fragment, until when, and that it may be ignored', () => {
    const letter = invitationLetter('bob@example.test', head());
    expect(letter.to).toBe('bob@example.test');
    expect(letter.subject).toBe('You have been invited to Purlay');
    expect(letter.text).toContain('Alice Doe invited you to join “Acme” on Purlay.');
    expect(letter.text).toContain(`https://purlay.test/invite#${TOKEN}`);
    expect(letter.text).toContain('October 28, 2026 at 9:30 AM UTC');
    expect(letter.text).toContain('you can ignore it');
    // The link in the html is the same link, made clickable.
    expect(letter.html).toContain(`<a href="https://purlay.test/invite#${TOKEN}">`);
  });

  test('is written in Turkish for a Turkish interface, with the same fixed subject', () => {
    const letter = invitationLetter('bob@example.test', head({ locale: 'tr' }));
    expect(letter.subject).toBe('Purlay’a davet edildin');
    expect(letter.text).toContain('Alice Doe seni Purlay’da “Acme” alanına');
    expect(letter.text).toContain('28 Ekim 2026');
    expect(letter.text).toContain('görmezden gelebilirsin');
  });

  test('puts nobody’s words in the subject, whatever the names say', () => {
    const letter = invitationLetter(
      'bob@example.test',
      head({ inviter: 'Bcc: x@evil.test\r\nSubject: hi', workspace: 'Your bank\nwarns you' }),
    );
    expect(letter.subject).toBe('You have been invited to Purlay');
    expect(letter.subject).not.toMatch(/[\r\n]/);
  });

  test('keeps a name on the line it was written on: no line of its own, no second paragraph', () => {
    const letter = invitationLetter(
      'bob@example.test',
      head({ inviter: 'Alice\n\nPay now:\nhttps://evil.test', workspace: 'Acme\r\nTeam' }),
    );
    const [first] = letter.text.split('\n\n');
    expect(first).toBe(
      'Alice Pay now: https: evil.test invited you to join “Acme Team” on Purlay.',
    );
    expect(letter.text.split('\n\n')).toHaveLength(4);
    expect(letter.text).not.toContain('https://evil.test');
  });

  test('escapes markup in the HTML part', () => {
    const letter = invitationLetter(
      'bob@example.test',
      head({ inviter: '<script>alert(1)</script>', workspace: '"><img src=x>' }),
    );
    expect(letter.html).not.toContain('<script>');
    expect(letter.html).not.toContain('<img');
    expect(letter.html).toContain('&lt;script&gt;');
  });
});

describe('quoting somebody else’s words', () => {
  test('strips control and invisible characters, including a right-to-left override', () => {
    expect(quotable('Al\u0000ice‮evil​', 'x')).toBe('Al ice evil');
  });

  test('collapses every kind of white space to one space', () => {
    expect(quotable('  a \t\n\r b c  d ', 'x')).toBe('a b c d');
  });

  test('breaks what a mail client would make a link of', () => {
    expect(quotable('see http://evil.test now', 'x')).not.toContain('://');
  });

  test('cuts a long name at sixty characters, whole letters, and says it was cut', () => {
    const cut = quotable('é'.repeat(200), 'x');
    expect(Array.from(cut)).toHaveLength(60);
    expect(cut.endsWith('…')).toBe(true);
    expect(quotable('é'.repeat(60), 'x')).toBe('é'.repeat(60));
  });

  test('a name with nothing left says the fallback', () => {
    expect(quotable('​ \n‮', 'Someone')).toBe('Someone');
    expect(quotable('', 'Someone')).toBe('Someone');
  });
});
