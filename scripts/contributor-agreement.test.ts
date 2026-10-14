/**
 * The contributor licence agreement's rule (#122, D-145): a maintainer and Dependabot need no
 * signature; anybody else has signed this version; nobody signs, or unsigns, for somebody else; and
 * the files it reads are what it says they are.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CLA_VERSION,
  claVerdict,
  maintainersIn,
  parseSignatures,
  type Signature,
} from './contributor-agreement';

const root = join(import.meta.dir, '..');
const signed = (github: string, version = CLA_VERSION): Signature => ({
  github,
  name: `${github} Person`,
  version,
  date: '2026-10-14',
});
const verdict = (
  author: string,
  before: readonly Signature[],
  after: readonly Signature[] = before,
): string => {
  const outcome = claVerdict({ author, maintainers: ['doancan'], before, after });
  return outcome.allowed ? `allowed: ${outcome.why}` : `refused: ${outcome.why}`;
};

describe('who may be merged', () => {
  test('a maintainer and Dependabot need no signature', () => {
    expect(verdict('doancan', [])).toBe('allowed: maintainer');
    expect(verdict('DoanCan', [])).toBe('allowed: maintainer');
    expect(verdict('app/dependabot', [])).toBe('allowed: bot');
  });

  test('somebody else has signed, on the base or in this pull request — this version', () => {
    expect(verdict('ada', [])).toStartWith('refused: ada has not signed');
    expect(verdict('ada', [signed('ada')])).toBe('allowed: signed');
    expect(verdict('ada', [], [signed('ada')])).toBe('allowed: signed');
    expect(verdict('ada', [signed('ada', '0.9')])).toBe(
      `refused: ada signed version 0.9; this is version ${CLA_VERSION}: sign it again`,
    );
  });

  test('nobody signs for somebody else, nor takes a signature away — a maintainer neither', () => {
    expect(verdict('ada', [], [signed('ada'), signed('bob')])).toStartWith(
      'refused: it signs for somebody else (bob)',
    );
    expect(verdict('doancan', [], [signed('bob')])).toStartWith(
      'refused: it signs for somebody else (bob)',
    );
    expect(verdict('ada', [signed('ada'), signed('bob')], [signed('ada')])).toBe(
      'refused: it removes a signature (bob)',
    );
  });
});

describe('what it reads', () => {
  test('a signatures file with a missing field, a bad login or a login twice is refused', () => {
    expect(() => parseSignatures('{}')).toThrow('not a list');
    expect(() => parseSignatures('[{"github":"ada","name":"Ada","version":"1.0"}]')).toThrow(
      'signature 1 has no valid "date"',
    );
    expect(() =>
      parseSignatures('[{"github":"-ada","name":"Ada","version":"1.0","date":"2026-10-14"}]'),
    ).toThrow('no valid "github"');
    const twice = JSON.stringify([signed('ada'), signed('ADA')]);
    expect(() => parseSignatures(twice)).toThrow('ada has signed twice');
    expect(parseSignatures(JSON.stringify([signed('ada')]))).toEqual([signed('ada')]);
  });

  test('the maintainers are the owners of the whole repository, never a team', () => {
    expect(maintainersIn('# owners\n*   @doancan @someone\n/docs/ @writer\n')).toEqual([
      'doancan',
      'someone',
    ]);
    expect(maintainersIn('* @org/team @doancan\n')).toEqual(['doancan']);
    expect(() => maintainersIn('/docs/ @writer\n')).toThrow('no owner for the whole repository');
  });

  test('the repository’s own files read: the signatures parse, and the copyright holder maintains', () => {
    expect(() =>
      parseSignatures(readFileSync(join(root, '.github/cla-signatures.json'), 'utf8')),
    ).not.toThrow();
    expect(maintainersIn(readFileSync(join(root, '.github/CODEOWNERS'), 'utf8'))).toContain(
      'doancan',
    );
  });
});
