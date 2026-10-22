import { describe, expect, test } from 'bun:test';
import { normalisedMailbox } from './mailbox';

describe('normalisedMailbox', () => {
  test('trims and lower-cases one mailbox', () => {
    expect(normalisedMailbox('  Ann.Doe+x@Example.TEST ')).toBe('ann.doe+x@example.test');
  });

  test('refuses what a mail library would read more than one mailbox, or a header, out of', () => {
    for (const typed of [
      'x<victim@example.test>',
      'a@b.test,c@d.test',
      'a@b.test c@d.test',
      'a@b.test\r\nBcc: v@e.test',
      'nobody',
      'a@b',
      'a@b.t',
      "a'@b.test",
      'a%b@c.test',
      '',
    ]) {
      expect(normalisedMailbox(typed)).toBeUndefined();
    }
  });

  test('refuses an address longer than a mailbox may be', () => {
    expect(normalisedMailbox(`${'a'.repeat(250)}@b.test`)).toBeUndefined();
  });
});
