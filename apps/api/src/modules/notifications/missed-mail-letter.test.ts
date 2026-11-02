/**
 * The missed-mail letter (D-240) as words: what each part says, in each language, and the HTML that is the
 * same text escaped, with only the server's own addresses made links.
 */
import { describe, expect, test } from 'bun:test';
import { missedLetter, type MissedLetterHead } from './missed-mail-letter';

const head = (overrides: Partial<MissedLetterHead> = {}): MissedLetterHead => ({
  to: 'ada@example.test',
  locale: 'en',
  appUrl: 'https://purlay.test',
  stopToken: 'a'.repeat(64),
  workspaces: [
    {
      name: 'Kokil Metal',
      slug: 'kokil',
      conversations: [
        {
          channelId: 'c1',
          name: null,
          messages: [
            { id: 'm1', author: 'Ayşe', content: 'selam' },
            { id: 'm2', author: 'Bora', content: '' },
            { id: 'm3', author: null, content: '`code` and **bold**' },
          ],
        },
      ],
    },
  ],
  ...overrides,
});

describe('the missed-mail letter', () => {
  test('a conversation without a name is named by who wrote; an author nobody knows is "Someone"; a message without words is its author alone', () => {
    const { text, to } = missedLetter(head());
    expect(to).toBe('ada@example.test');
    expect(text).toContain('Kokil Metal\nAyşe, Bora, Someone — 3 messages');
    expect(text).toContain('  Ayşe: “selam”\nhttps://purlay.test/w/kokil/c/c1?message=m1');
    expect(text).toContain('  Bora\nhttps://purlay.test/w/kokil/c/c1?message=m2');
    expect(text).toContain('  Someone: “code and bold”');
    expect(text).toContain('Open Purlay:\nhttps://purlay.test\n');
    expect(text).not.toContain('more');
    expect(text.endsWith(`https://purlay.test/mail/stop#${'a'.repeat(64)}`)).toBe(true);
  });

  test('the HTML is the text, paragraph by paragraph, every character escaped and only the addresses linked', () => {
    const { html } = missedLetter(
      head({
        workspaces: [
          {
            name: 'A & <B>',
            slug: 'a-b',
            conversations: [
              {
                channelId: 'c1',
                name: 'genel',
                messages: [{ id: 'm1', author: '"Q"', content: 'x' }],
              },
            ],
          },
        ],
      }),
    );
    expect(html).toContain('<p>A &amp; &lt;B&gt;<br>#genel — 1 message<br>');
    expect(html).toContain('&quot;Q&quot;: “x”');
    expect(html).toContain(
      '<a href="https://purlay.test/w/a-b/c/c1?message=m1">https://purlay.test/w/a-b/c/c1?message=m1</a>',
    );
    expect(html.match(/<a /g)).toHaveLength(3);
    expect(html.startsWith('<p>Messages that need you')).toBe(true);
  });

  test('in Turkish, a workspace with no name left is said in words', () => {
    const { subject, text } = missedLetter(
      head({
        locale: 'tr',
        workspaces: [
          {
            name: '‮',
            slug: 's',
            conversations: [
              { channelId: 'c', name: 'x', messages: [{ id: 'm', author: 'A', content: 'b' }] },
            ],
          },
        ],
      }),
    );
    expect(subject).toBe('Purlay’da seni bekleyen mesajlar var');
    expect(text).toContain('Bir çalışma alanı\n#x — 1 mesaj');
    expect(text).toContain('Purlay’ı aç:');
  });

  test('past three messages in a conversation, the rest are counted, in English too', () => {
    const messages = [1, 2, 3, 4, 5].map((n) => ({
      id: `m${String(n)}`,
      author: 'Ayşe',
      content: `n${String(n)}`,
    }));
    const { text } = missedLetter(
      head({
        workspaces: [
          { name: 'W', slug: 'w', conversations: [{ channelId: 'c', name: 'x', messages }] },
        ],
      }),
    );
    expect(text).toContain('#x — 5 messages');
    expect(text).toContain('  and 2 more');
    expect(text).not.toContain('“n2”');
    expect(text).toContain('“n5”');
  });
});
