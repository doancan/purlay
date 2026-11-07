/**
 * What `bun run module:new` leaves for its author to say, marked FILL in double angle brackets in the decision and in the
 * module's section of `MODULES.md`: a module is not merged with a sentence nobody wrote (`docs/MODULE-GUIDE.md`).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'bun:test';

const ROOT = join(import.meta.dir, '../../../..');
/** Spelled in two pieces so that this file does not hold what it looks for. */
const MARKER = ['<<', 'FILL', '>>'].join('');
const KINDS = /\.(md|ts|tsx|sql)$/;
/** The generator's own files name the marker: they are where it comes from. */
const GENERATOR = 'apps/api/src/testing/module-new';

test('no file still holds a placeholder the generator left', () => {
  const files = Bun.spawnSync(['git', 'ls-files', '-co', '--exclude-standard', '-z'], { cwd: ROOT })
    .stdout.toString()
    .split('\0')
    .filter((file) => KINDS.test(file) && !file.startsWith(GENERATOR));
  const left = files.flatMap((file) =>
    readFileSync(join(ROOT, file), 'utf8')
      .split('\n')
      .flatMap((line, at) => (line.includes(MARKER) ? [`${file}:${String(at + 1)}`] : [])),
  );
  expect(left).toEqual([]);
});
