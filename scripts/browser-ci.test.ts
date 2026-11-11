/** Execute CI's browser lifecycle with controlled Docker/network failures, without starting Docker. */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

interface Step {
  id?: string;
  run?: string;
  uses?: string;
  if?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
  'continue-on-error'?: boolean;
}
const action = Bun.YAML.parse(readFileSync('.github/actions/browsers/action.yml', 'utf8')) as {
  runs: { steps: Step[] };
};
const start = action.runs.steps.find((step) => step.id === 'start')!;
const cleanup = action.runs.steps.find((step) => step.id === 'cleanup')!;
const dependency = (
  JSON.parse(readFileSync('apps/web/package.json', 'utf8')) as {
    devDependencies: Record<string, string>;
  }
).devDependencies['@playwright/test']!;
const cid = 'a'.repeat(64);
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

interface Result {
  exitCode: number;
  output: string;
  calls: string;
  published: string;
}
const execute = (
  step: Step,
  overrides: Record<string, string> = {},
  version = dependency,
): Result => {
  const directory = mkdtempSync(join(tmpdir(), 'purlay-browser-ci-'));
  directories.push(directory);
  mkdirSync(join(directory, 'apps/web'), { recursive: true });
  mkdirSync(join(directory, 'bin'));
  writeFileSync(
    join(directory, 'apps/web/package.json'),
    JSON.stringify({ devDependencies: { '@playwright/test': version } }),
  );
  const calls = join(directory, 'calls');
  const output = join(directory, 'environment');
  writeFileSync(calls, '');
  writeFileSync(output, '');
  writeFileSync(
    join(directory, 'bin/docker'),
    `#!/bin/sh
printf '%s\\n' "$@" >> "$CALLS"
case "$1" in
  run) [ "\${RUN_FAIL:-0}" = 0 ] || exit 1; printf '%s\\n' "$RESULT_CID" ;;
  inspect) printf '%s\\n' "\${RUNNING:-true}" ;;
  rm) exit 0 ;;
  *) exit 2 ;;
esac
`,
    { mode: 0o755 },
  );
  writeFileSync(join(directory, 'bin/curl'), '#!/bin/sh\nexit "${CURL_FAIL:-0}"\n', {
    mode: 0o755,
  });
  const done = Bun.spawnSync(['/bin/bash', '-euo', 'pipefail', '-c', step.run!], {
    cwd: directory,
    env: {
      ...step.env,
      PATH: `${join(directory, 'bin')}:${dirname(process.execPath)}:/usr/bin:/bin`,
      GITHUB_WORKSPACE: directory,
      GITHUB_ENV: output,
      CALLS: calls,
      RESULT_CID: cid,
      CI_BROWSER_CONTAINER_ID: cid,
      ...overrides,
    },
  });
  return {
    exitCode: done.exitCode,
    output: done.stderr.toString(),
    calls: readFileSync(calls, 'utf8'),
    published: readFileSync(output, 'utf8'),
  };
};

describe('the pinned CI browser server', () => {
  test('pins the matching official image by immutable digest', () => {
    expect(start.env?.['CI_BROWSER_IMAGE']).toMatch(
      new RegExp(
        `^mcr\\.microsoft\\.com/playwright:v${dependency.replaceAll('.', '\\.')}-resolute@sha256:[a-f0-9]{64}$`,
      ),
    );
  });

  test('refuses an incompatible client before contacting Docker', () => {
    const done = execute(start, {}, '0.0.0');
    expect(done.exitCode).not.toBe(0);
    expect(done.output).toContain('does not match');
    expect(done.calls).toBe('');
    expect(done.published).toBe('');
  });

  test.each([{ RUN_FAIL: '1' }, { RESULT_CID: 'invalid' }])(
    'does not publish a server or cleanup id when Docker start fails: %j',
    (failure) => {
      const done = execute(start, failure);
      expect(done.exitCode, JSON.stringify(done)).not.toBe(0);
      expect(done.published).toBe('');
    },
  );

  test.each([{ CURL_FAIL: '7' }, { RUNNING: 'false' }])(
    'retains only its own cleanup id when readiness fails: %j',
    (failure) => {
      const done = execute(start, failure);
      expect(done.exitCode).not.toBe(0);
      expect(done.published).toBe(`CI_BROWSER_CONTAINER_ID=${cid}\n`);
    },
  );

  test('publishes a ready server using direct host networking and a read-only checkout', () => {
    const done = execute(start);
    expect(done.exitCode).toBe(0);
    expect(done.published).toBe(
      `CI_BROWSER_CONTAINER_ID=${cid}\nPW_TEST_CONNECT_WS_ENDPOINT=ws://127.0.0.1:3000/\n`,
    );
    expect(done.calls).toContain('--network=host\n');
    expect(done.calls).toContain('--init\n--ipc=host\n');
    expect(done.calls).toContain('target=/work,readonly');
    expect(done.calls).toContain('run-server\n--host\n127.0.0.1\n');
    expect(done.calls).not.toContain('--env');
    expect(done.published).not.toContain('PW_TEST_CONNECT_EXPOSE_NETWORK');
  });

  test('cleanup runs after a failure and removes only the recorded container', () => {
    expect(start.if).toBe("inputs.cleanup != 'true'");
    expect(cleanup.if).toContain('always()');
    const done = execute(cleanup);
    expect(done.exitCode).toBe(0);
    expect(done.calls).toBe(`rm\n--force\n${cid}\n`);
  });

  test.each(['browser', 'webkit'])('%s wires startup and unconditional cleanup', (name) => {
    const workflow = Bun.YAML.parse(readFileSync('.github/workflows/ci.yml', 'utf8')) as {
      jobs: Record<string, { steps: Step[] }>;
    };
    const steps = workflow.jobs[name]!.steps;
    const lifecycle = steps.filter((step) => step.uses === './.github/actions/browsers');
    expect(lifecycle).toHaveLength(2);
    expect(lifecycle[0]?.if).toBeUndefined();
    expect(lifecycle[0]?.['continue-on-error']).not.toBe(true);
    expect(lifecycle[1]?.if).toBe("always() && env.CI_BROWSER_CONTAINER_ID != ''");
    expect(lifecycle[1]?.with?.['cleanup']).toBe('true');
    expect(steps.findIndex((step) => step === lifecycle[1])).toBeGreaterThan(
      steps.findIndex((step) => step.run === 'bun run test:e2e'),
    );
  });
});
