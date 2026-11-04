/**
 * `bun run db:migrate` refuses a `MODULES` setting the API would refuse: it exits 1 and names the setting and
 * the problem, before it opens a connection (the address below leads nowhere), instead of saying "nothing to
 * apply" and leaving the refusal to the next boot. `apps/api/src/module-setting-pair.test.ts` holds the two
 * readings together; this holds the command's own behaviour.
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

const COMMAND = join(import.meta.dir, 'migrate.ts');
const COMMAND_MS = 20_000;

const run = (
  modules: string,
): { readonly code: number; readonly stdout: string; readonly stderr: string } => {
  const result = Bun.spawnSync(['bun', '--no-env-file', 'run', COMMAND], {
    env: {
      PATH: process.env['PATH'] ?? '',
      HOME: process.env['HOME'] ?? '',
      DATABASE_URL: 'postgres://nobody:nothing@127.0.0.1:1/none',
      MODULES: modules,
    },
  });
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
};

describe('db:migrate reads MODULES', () => {
  test.each([
    ['CHAT', 'MODULES names "CHAT", which is not a module id'],
    ['None', 'MODULES names "None", which is not a module id'],
    ['chat;issues', 'MODULES names "chat;issues", which is not a module id'],
    ['chat,calendar', 'MODULES names "calendar", which this build does not have'],
    ['chat,chat', 'MODULES names "chat" twice'],
    ['none,chat', 'none must stand alone'],
    [',', 'MODULES has an empty item'],
  ])(
    'exits 1 for %p and says why',
    (setting, problem) => {
      const { code, stdout, stderr } = run(setting);
      expect(code).toBe(1);
      expect(stderr).toContain('MODULES cannot start this process');
      expect(stderr).toContain(problem);
      expect(stdout).not.toContain('nothing to apply');
      expect(stdout).not.toContain('applied');
    },
    COMMAND_MS,
  );

  test(
    'goes on to the database for a setting the API accepts',
    () => {
      const { stderr } = run('chat');
      expect(stderr).not.toContain('MODULES cannot start this process');
    },
    COMMAND_MS,
  );
});
