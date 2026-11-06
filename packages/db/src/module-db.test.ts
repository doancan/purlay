/**
 * A module's handle holds exactly its own tables and the core tables it names (D-271, `MODULES.md` §4).
 *
 * `@ts-expect-error` is checked by `tsc` alone, and `bun run mutate` runs `bun test` alone, so a change to the type
 * that let a foreign table through would pass every test it could run. This test asks the compiler itself, through
 * its API, about a program of small cases: each *refused* case is paired with the same statement over a table the
 * handle holds, which must compile, so a refusal cannot be a typo in the case. It also holds both directions of
 * assignability that kysely's generics make a matter of luck (`Transaction<DB>` to `Kysely<Sub>` and back do not
 * compile), so a kysely upgrade that flips one fails here, by name.
 */
import { dirname, join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import ts from 'typescript';

const SOURCE_ROOT = import.meta.dir;
/** A file in the package's own folder, so that `./client`, `./schema` and `kysely` resolve as they do for the package. */
const FIXTURE_FILE = join(SOURCE_ROOT, 'module-db.fixture.ts');

const PREAMBLE = `
import type { Transaction } from 'kysely';
import type { Executor } from './client';
import type { ModuleDb, ModuleSchema, ModuleTransaction } from './module-db';
import type { DB } from './schema';
type Own = ModuleSchema<'issues', 'users' | 'workspaces'>;
type Handle = ModuleDb<Own>;
type Tx = ModuleTransaction<Own>;
declare const handle: Handle;
declare const tx: Tx;
declare const whole: Executor;
declare const wholeTx: Transaction<DB>;
`;

interface Case {
  readonly name: string;
  /** One line, so that a diagnostic's line says which case it belongs to. */
  readonly code: string;
  /** What the compiler's message must name when the case is refused: the thing that is not allowed. */
  readonly refuses?: string;
}

const CASES: readonly Case[] = [
  // What a module may do.
  { name: 'reads its own table', code: `handle.selectFrom('issues').selectAll();` },
  { name: 'reads a core table it names', code: `handle.selectFrom('users').select('id');` },
  {
    name: 'joins a core table it names',
    code: `handle.selectFrom('issues').innerJoin('users', 'users.id', 'issues.created_by').select('users.id');`,
  },
  {
    name: 'reads a core table it names in a subquery',
    code: `handle.selectFrom('issues').where('id', 'in', (eb) => eb.selectFrom('workspaces').select('id'));`,
  },
  {
    name: 'writes its own table',
    code: `handle.insertInto('issues').values({ id: '', title: '', workspace_id: '' });`,
  },
  { name: 'reads its own table in a transaction', code: `tx.selectFrom('issues').selectAll();` },
  {
    name: 'opens a transaction on its own table',
    code: `handle.transaction().execute((trx) => trx.selectFrom('issues').selectAll().execute());`,
  },
  // What it may not.
  {
    name: 'reads a table another module owns',
    code: `handle.selectFrom('channels').selectAll();`,
    refuses: 'channels',
  },
  {
    name: 'reads a core table it did not name',
    code: `handle.selectFrom('sessions').selectAll();`,
    refuses: 'sessions',
  },
  {
    name: 'joins another module table',
    code: `handle.selectFrom('issues').innerJoin('channels', 'channels.id', 'issues.id').select('issues.id');`,
    refuses: 'channels',
  },
  {
    name: 'writes another module table',
    code: `handle.insertInto('channels');`,
    refuses: 'channels',
  },
  {
    name: 'updates another module table',
    code: `handle.updateTable('channels');`,
    refuses: 'channels',
  },
  {
    name: 'deletes from another module table',
    code: `handle.deleteFrom('channels');`,
    refuses: 'channels',
  },
  {
    name: 'reads another module table in a subquery',
    code: `handle.selectFrom('issues').where('id', 'in', (eb) => eb.selectFrom('channels').select('id'));`,
    refuses: 'channels',
  },
  {
    name: 'reads another module table in a transaction',
    code: `tx.selectFrom('channels').selectAll();`,
    refuses: 'channels',
  },
  {
    name: 'reads another module table in a transaction it opened',
    code: `handle.transaction().execute((trx) => trx.selectFrom('channels').selectAll().execute());`,
    refuses: 'channels',
  },
  {
    name: 'indexes the schema by a foreign table',
    code: `type Foreign = Own['channels'];`,
    refuses: 'channels',
  },
  // How a handle is given and taken: what kysely's generics do not give for free.
  {
    name: 'is given the whole database executor',
    code: `((db: Handle): Handle => db)(whole);`,
  },
  {
    name: 'is given a whole-database transaction',
    code: `((db: Handle): Handle => db)(wholeTx);`,
  },
  {
    name: 'is given a transaction of its own as a handle',
    code: `((db: Handle): Handle => db)(tx);`,
  },
  {
    name: 'is given a whole-database transaction where a transaction of its own is wanted',
    code: `((db: Tx): Tx => db)(wholeTx);`,
  },
  {
    name: 'hands its handle where the core wants an executor',
    code: `((db: Executor): Executor => db)(handle);`,
  },
  {
    name: 'hands its transaction where the core wants an executor',
    code: `((db: Executor): Executor => db)(tx);`,
  },
  {
    name: 'hands its transaction where the core wants a transaction',
    code: `((db: Transaction<DB>): Transaction<DB> => db)(tx);`,
  },
  // What may be named at all.
  {
    name: 'names a module and a core table it reads',
    code: `type Fine = ModuleSchema<'chat', 'users'>;`,
  },
  {
    name: 'reads as a core table what another module owns',
    code: `type Bad = ModuleSchema<'issues', 'channels'>;`,
    refuses: 'channels',
  },
  {
    name: 'is a module of the core',
    code: `type Bad = ModuleSchema<'core', 'users'>;`,
    refuses: 'core',
  },
];

/** The compiler's diagnostics for the cases, each as the messages whose line falls in the case's. */
const diagnosticsPerCase = (): ReadonlyMap<string, readonly string[]> => {
  const preambleLines = PREAMBLE.split('\n').length - 1;
  const source = `${PREAMBLE}${CASES.map((each) => each.code).join('\n')}\n`;
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.Preserve,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    types: [],
    noUnusedLocals: false,
  };
  const real = ts.createCompilerHost(options);
  const host: ts.CompilerHost = {
    ...real,
    fileExists: (file) => file === FIXTURE_FILE || real.fileExists(file),
    readFile: (file) => (file === FIXTURE_FILE ? source : real.readFile(file)),
    getSourceFile: (file, languageVersion, onError, shouldCreate) =>
      file === FIXTURE_FILE
        ? ts.createSourceFile(file, source, languageVersion, true)
        : real.getSourceFile(file, languageVersion, onError, shouldCreate),
  };
  const program = ts.createProgram([FIXTURE_FILE], options, host);
  const fixture = program.getSourceFile(FIXTURE_FILE);
  if (fixture === undefined) throw new Error('the fixture program has no fixture');

  const perCase = new Map<string, string[]>(CASES.map((each) => [each.name, []]));
  for (const diagnostic of ts.getPreEmitDiagnostics(program, fixture)) {
    const line = fixture.getLineAndCharacterOfPosition(diagnostic.start ?? 0).line;
    const owner = CASES[line - preambleLines];
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
    if (owner === undefined)
      throw new Error(`a diagnostic outside every case, line ${String(line + 1)}: ${message}`);
    perCase.get(owner.name)?.push(message);
  }
  return perCase;
};

describe('a module handle', () => {
  const diagnostics = diagnosticsPerCase();

  test('the fixture is a program of its own, in the package', () => {
    expect(dirname(FIXTURE_FILE)).toBe(SOURCE_ROOT);
    expect(new Set(CASES.map((each) => each.name)).size).toBe(CASES.length);
    expect(CASES.some((each) => each.refuses !== undefined)).toBe(true);
  });

  for (const each of CASES) {
    const { refuses } = each;
    if (refuses === undefined) {
      test(`${each.name}: compiles`, () => {
        expect(diagnostics.get(each.name)).toEqual([]);
      });
      continue;
    }
    test(`${each.name}: does not compile, and says which name`, () => {
      const messages = diagnostics.get(each.name) ?? [];
      expect(messages.length).toBeGreaterThan(0);
      expect(messages.join('\n')).toContain(refuses);
    });
  }
});
