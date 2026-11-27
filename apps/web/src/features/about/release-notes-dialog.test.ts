import { describe, expect, test } from 'bun:test';
import { readableNote } from './release-notes-dialog';

describe('a release note bullet, as the window shows it', () => {
  test('starts with a capital, since it stands alone under its area', () => {
    expect(readableNote('a message can be sent as Important')).toBe(
      'A message can be sent as Important',
    );
  });

  test('keeps a first word that is a name as it is written', () => {
    expect(readableNote('iOS clients have a minimum of their own')).toBe(
      'iOS clients have a minimum of their own',
    );
    expect(readableNote('`bun run quota:set` limits a workspace')).toBe(
      '`bun run quota:set` limits a workspace',
    );
  });

  test('leaves out the decisions it cites', () => {
    expect(readableNote('an operator can keep a ledger (D-317, D-318)')).toBe(
      'An operator can keep a ledger',
    );
  });
});
