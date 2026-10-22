import { describe, expect, test } from 'bun:test';
import {
  COMMON_PASSWORDS,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  passwordProblem,
  type PasswordProblem,
} from './password';

const owner = { email: 'ada.lovelace@example.com', name: 'Ada Lovelace' };

describe('the password policy (D-179 §4)', () => {
  test('is ten to a hundred and twenty-eight characters, as the library is told', () => {
    expect(PASSWORD_MIN_LENGTH).toBe(10);
    expect(PASSWORD_MAX_LENGTH).toBe(128);
  });

  const table: readonly (readonly [string, PasswordProblem | undefined])[] = [
    ['correct horse battery', undefined],
    ['n9#Kq2!vXp', undefined],
    ['n9#Kq2!vX', 'too-short'],
    ['', 'too-short'],
    ['abcdefgh'.repeat(16), undefined],
    ['x'.repeat(129), 'too-long'],
    // The address, whole or its local part, in any case and anywhere in the password.
    ['ada.lovelace@example.com', 'contains-email'],
    ['my ADA.LOVELACE@EXAMPLE.COM!', 'contains-email'],
    ['ada.lovelace-2026', 'contains-email'],
    // The display name, in any case, spaces and all.
    ['i am ada lovelace', 'contains-name'],
    ['ADA LOVELACE!!', 'contains-name'],
    // The commonest ones of ten or more, in any case.
    ['1234567890', 'common'],
    ['Password123', 'common'],
    ['QWERTYUIOP', 'common'],
    ['1q2w3e4r5t', 'common'],
    ['iloveyou123', 'common'],
    ['administrator', 'common'],
    // Obvious variants of a common one: case, and digits or marks added at the end.
    ['Password123!', 'common'],
    ['Qwertyuiop2026', 'common'],
    ['iloveyou!!!!', 'common'],
    // A control character has no place in a password; nothing but spaces is not one.
    ['correct\u0000horse battery', 'invalid-character'],
    ['line one\nline two', 'invalid-character'],
    ['            ', 'blank'],
    // Fewer than four different characters, however long.
    ['aaaaaaaaaaaa', 'repetitive'],
    ['abababababab', 'repetitive'],
    ['abcabcabcabc', 'repetitive'],
    ['abcdabcdabcd', undefined],
    // Normalised before it is compared: a full-width copy of the address is the address.
    ['ＡＤＡ．ＬＯＶＥＬＡＣＥ＠ＥＸＡＭＰＬＥ．ＣＯＭ', 'contains-email'],
    // A word of the name of four or more is enough.
    ['lovelace and babbage', 'contains-name'],
    ['ada and the engine', undefined],
  ];

  for (const [password, problem] of table) {
    test(`${JSON.stringify(password.length > 40 ? `${password.slice(0, 8)}…(${String(password.length)})` : password)} is ${problem ?? 'accepted'}`, () => {
      expect(passwordProblem(password, owner)).toBe(problem);
    });
  }

  test('a local part shorter than four, or a name shorter than four, is not a rule: it would refuse half the language', () => {
    const short = { email: 'al@example.com', name: 'Bo' };
    expect(passwordProblem('always albatross', short)).toBeUndefined();
    expect(passwordProblem('bonfire on the hill', short)).toBeUndefined();
    // The whole address still is.
    expect(passwordProblem('al@example.com is me', short)).toBe('contains-email');
  });

  test('is measured as the library measures, in UTF-16 units', () => {
    // Five emoji are ten units: the library's own minimum agrees.
    expect(passwordProblem('🔑🔒🗝🚪🧱', owner)).toBeUndefined();
    expect(passwordProblem('🔑🔒🚪🧱', owner)).toBe('too-short');
  });

  test('every common password listed is at least the minimum and lower case, so each one is a rule that can fire', () => {
    expect(COMMON_PASSWORDS.size).toBeGreaterThanOrEqual(30);
    for (const common of COMMON_PASSWORDS) {
      expect(common.length).toBeGreaterThanOrEqual(PASSWORD_MIN_LENGTH);
      expect(common).toBe(common.toLowerCase());
      expect(passwordProblem(common, owner)).toBe('common');
    }
  });
});
