/**
 * The escape-hatch rules, run in this process, branch by branch (#136).
 *
 * `verify:enforcement` proves each rule refuses a real file — in a linter it
 * starts, which coverage cannot see into. This runs the same rules here, through
 * the same configuration, on every branch they have, refusing and accepting.
 *
 * The text is linted as `eslint.config.mjs`: that path takes the repository's
 * configuration without the type-aware parser, which needs a file a TypeScript
 * project knows. These rules read comments only, so nothing about them changes.
 */
import { describe, expect, test } from 'bun:test';
import { ESLint } from 'eslint';

const eslint = new ESLint();

/** The rules that fired, and whether a disable went unused. */
const verdict = async (code: string): Promise<string[]> => {
  const [result] = await eslint.lintText(code, { filePath: 'eslint.config.mjs' });
  return (result?.messages ?? []).map(
    (message) =>
      message.ruleId ??
      (message.message.startsWith('Unused eslint-disable directive') ? 'unused' : 'other'),
  );
};

describe('a disable must account for itself', () => {
  test('one that names its rule, explains itself and links an issue is accepted', async () => {
    expect(
      await verdict(
        "// eslint-disable-next-line no-console -- printing is this line's job (#136)\nconsole.log(1);\n",
      ),
    ).toEqual([]);
  });

  test('one with no issue link is refused', async () => {
    expect(
      await verdict(
        '// eslint-disable-next-line no-console -- printing is fine\nconsole.log(1);\n',
      ),
    ).toContain('purlay/accountable-disable');
  });

  test('one with no explanation at all is refused', async () => {
    expect(await verdict('// eslint-disable-next-line no-console\nconsole.log(1);\n')).toContain(
      'purlay/accountable-disable',
    );
  });

  test('one that names no rule is refused', async () => {
    expect(await verdict('// eslint-disable-next-line\nconsole.log(1);\n')).toContain(
      'purlay/accountable-disable',
    );
  });

  test('one for a whole file or block is refused, explained or not', async () => {
    expect(
      await verdict('/* eslint-disable no-console -- all of it (#136) */\nconsole.log(1);\n'),
    ).toContain('purlay/accountable-disable');
  });

  test('one that suppresses nothing fails', async () => {
    expect(
      await verdict(
        '// eslint-disable-next-line no-console -- nothing here prints (#136)\nexport const a = 1;\n',
      ),
    ).toContain('unused');
  });
});

describe('debt has an owner', () => {
  test('a TODO with an issue is accepted', async () => {
    expect(await verdict('// TODO(#136) make this faster\nexport const a = 1;\n')).toEqual([]);
  });

  for (const marker of ['TODO', 'FIXME', 'XXX', 'HACK']) {
    test(`a ${marker} without one is refused`, async () => {
      expect(await verdict(`// ${marker} make this faster\nexport const a = 1;\n`)).toContain(
        'purlay/owned-debt',
      );
    });
  }
});

describe('an expected type error in source has an owner', () => {
  test('one that links an issue is accepted', async () => {
    expect(
      await verdict(
        '// @ts-expect-error the library types this wrong (#136)\nexport const a = 1;\n',
      ),
    ).toEqual([]);
  });

  test('one that does not is refused', async () => {
    expect(
      await verdict('// @ts-expect-error the library types this wrong\nexport const a = 1;\n'),
    ).toContain('purlay/owned-expected-error');
  });
});

/**
 * Test-only code stays out of what ships (#245). Linted as a real production
 * file so the path-scoped configuration and the type-aware parser both apply;
 * the text replaces what is on disk.
 */
describe('production code does not import test-only code', () => {
  const refused = async (code: string, filePath: string): Promise<boolean> => {
    const [result] = await eslint.lintText(code, { filePath });
    return (result?.messages ?? []).some((m) => m.ruleId === 'purlay/no-test-code-import');
  };
  const PRODUCTION = 'apps/api/src/ingress/http/validate.ts';

  test('a static import, a re-export and a dynamic import are each refused', async () => {
    expect(await refused("import { a } from '../../testing/doubles';\nvoid a;\n", PRODUCTION)).toBe(
      true,
    );
    expect(await refused("export { a } from './x.testing';\n", PRODUCTION)).toBe(true);
    expect(await refused("export * from '../../testing/users';\n", PRODUCTION)).toBe(true);
    expect(await refused("await import('../../testing/users');\n", PRODUCTION)).toBe(true);
  });

  test('a path that merely holds the word, an export with no source and a computed import are not', async () => {
    expect(await refused("import { a } from './attesting';\nvoid a;\n", PRODUCTION)).toBe(false);
    expect(await refused('export const a = 1;\n', PRODUCTION)).toBe(false);
    expect(await refused('await import(String(1));\n', PRODUCTION)).toBe(false);
  });

  test('a test and the testing directory itself may', async () => {
    const code = "import { a } from '../../testing/doubles';\nvoid a;\n";
    expect(await refused(code, 'apps/api/src/ingress/http/app.test.ts')).toBe(false);
    expect(await refused(code, 'apps/api/src/testing/doubles.ts')).toBe(false);
  });
});
