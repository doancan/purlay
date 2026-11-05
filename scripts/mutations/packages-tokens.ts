// Area packages-tokens: ids ascending; areas.ts says what belongs here.
import type { Mutation } from '../mutate';

export const PACKAGES_TOKENS: readonly Mutation[] = [
  {
    id: 'celebration-family-is-one-name',
    why: "only the original celebration token may run longer, so the release show's token is refused by the audit",
    file: 'packages/tokens/src/model.ts',
    find: 'name === CELEBRATION_TOKEN || name.startsWith(`${CELEBRATION_TOKEN}-`)',
    replace: 'name === CELEBRATION_TOKEN',
    tests: ['packages/tokens/src/tokens.test.ts'],
  },
  {
    id: 'midnight-drawn-light-for-the-platform',
    why: 'Midnight is told to the platform as a light scheme: white scrollbars and native controls on a dark page (D-184)',
    file: 'packages/tokens/src/model.ts',
    find: "theme === 'light' ? 'light' : 'dark'",
    replace: "theme === 'light' || theme === 'midnight' ? 'light' : 'dark'",
    tests: ['packages/tokens/src/tokens.test.ts'],
  },
  {
    id: 'vocabulary-judged-on-one-compiler',
    why: 'one raw class is reported against every class after it, and a class that builds nothing passes behind one that did',
    file: 'packages/tokens/src/vocabulary.ts',
    find: '  const judged = new Map<string, string | undefined>();\n  const judge = async (candidate: string): Promise<string | undefined> => {\n    const css = (await freshCompiler()).build([candidate]);\n',
    replace:
      '  const judged = new Map<string, string | undefined>();\n  const shared = await freshCompiler();\n  const judge = async (candidate: string): Promise<string | undefined> => {\n    const css = shared.build([candidate]);\n',
    tests: ['packages/tokens/src/vocabulary.test.ts'],
  },
  {
    id: 'vocabulary-skips-a-named-class-constant',
    why: 'a class list kept in a constant not called …Classes builds and ships a raw value unchecked',
    file: 'packages/tokens/src/vocabulary.ts',
    find: '    namesIn(root, named);\n',
    replace: '',
    tests: ['packages/tokens/src/vocabulary.test.ts'],
  },
  {
    id: 'vocabulary-takes-a-comparison-for-a-class',
    why: 'a status compared in a className is reported as a class that builds nothing',
    file: 'packages/tokens/src/vocabulary.ts',
    find: '  } else if (ts.isBinaryExpression(node) && COMPARISONS.has(node.operatorToken.kind)) return;\n',
    replace: '  }\n',
    tests: ['packages/tokens/src/vocabulary.test.ts'],
  },
];
