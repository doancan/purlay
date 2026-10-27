/**
 * The server's runner only ever runs what was merged (D-185).
 *
 * A self-hosted runner executes the workflow's steps on the machine that holds the production
 * database and its secrets. A pull request's workflow is written by whoever opened it, so the one
 * way that machine is exposed is a workflow that runs there on something a stranger can start.
 * "The deploy runs only after a merge" was a comment in `deploy.yml`; this is what holds it.
 */
import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const WORKFLOWS = join(import.meta.dir, '../.github/workflows');
const read = (name: string): string => readFileSync(join(WORKFLOWS, name), 'utf8');
const names = readdirSync(WORKFLOWS).filter((name) => /\.ya?ml$/.test(name));

/** The top-level `on:` block's event names. */
const events = (text: string): readonly string[] => {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => /^on:\s*$/.test(line));
  if (start === -1) return [];
  const found: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const event = /^ {2}([\w_]+):/.exec(line);
    if (event?.[1] !== undefined) found.push(event[1]);
  }
  return found;
};

/** The text of one job, from its name to the next job. */
const job = (text: string, name: string): string => {
  const start = text.indexOf(`\n  ${name}:\n`);
  expect(start, `no job ${name}`).toBeGreaterThan(-1);
  const rest = text.slice(start + 1);
  const next = /\n {2}[\w-]+:\n/.exec(rest.slice(name.length + 4));
  return next === null ? rest : rest.slice(0, next.index + name.length + 4);
};

const leadingSpaces = (line: string): number => /^ */.exec(line)?.[0].length ?? 0;

/** The shell of the step called `name`, as the runner would receive it. */
const stepRun = (text: string, name: string): string => {
  const start = text.indexOf(`- name: ${name}`);
  expect(start, `no step ${name}`).toBeGreaterThan(-1);
  const rest = text.slice(start);
  const runAt = rest.indexOf('run: |\n');
  expect(runAt, `step ${name} has no run block`).toBeGreaterThan(-1);
  const lines = rest.slice(runAt + 'run: |\n'.length).split('\n');
  const indent = leadingSpaces(lines[0] ?? '');
  const body: string[] = [];
  for (const line of lines) {
    if (line.trim() === '') {
      body.push('');
      continue;
    }
    if (leadingSpaces(line) < indent) break;
    body.push(line.slice(indent));
  }
  return body.join('\n');
};

/** Every line that is part of a `run:` (the one-line form and the block form). */
const runLines = (text: string): readonly string[] => {
  const found: string[] = [];
  const lines = text.split('\n');
  for (const [index, line] of lines.entries()) {
    const start = /^(\s*)(?:- )?run:\s*(.*)$/.exec(line);
    if (start === null) continue;
    const [, space = '', rest = ''] = start;
    if (rest !== '|' && rest !== '>') {
      found.push(rest);
      continue;
    }
    for (const next of lines.slice(index + 1)) {
      if (next.trim() !== '' && leadingSpaces(next) <= space.length) break;
      found.push(next);
    }
  }
  return found;
};

describe('the events that can reach the server', () => {
  test('the reader finds the events', () => {
    expect(
      events('name: x\non:\n  push:\n    branches: [main]\n  workflow_dispatch:\n\njobs:\n'),
    ).toEqual(['push', 'workflow_dispatch']);
    expect(events('name: x\n')).toEqual([]);
  });

  test('the deploy runs on a merge to main or a person starting it, and nothing else', () => {
    expect(events(read('deploy.yml'))).toEqual(['workflow_run', 'workflow_dispatch']);
    expect(read('deploy.yml')).toContain('workflows: [image]');
    expect(read('deploy.yml')).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(read('deploy.yml')).toContain("github.event.workflow_run.event == 'push'");
    expect(read('deploy.yml')).toContain('head_repository.full_name == github.repository');
  });

  test('no workflow runs on the server unless it is the deploy', () => {
    const onTheServer = names.filter((name) => /self-hosted|purlay-server/.test(read(name)));
    expect(onTheServer).toEqual(['deploy.yml']);
  });
});

describe('what the deploy is allowed', () => {
  const text = read('deploy.yml');

  test('every job runs on the server, and nowhere a stranger could be', () => {
    for (const name of ['deploy']) {
      expect(job(text, name)).toMatch(/runs-on: \[self-hosted, linux, x64, purlay-server\]/);
    }
  });

  test('only the release job can write, and what it writes is contents', () => {
    expect(job(text, 'deploy')).not.toContain('write');
    expect(job(text, 'deploy')).toContain('packages: read');
    expect(job(text, 'release')).toContain('runs-on: ubuntu-latest');
    expect(job(text, 'release')).toContain('ref: ${{ needs.deploy.outputs.commit }}');
    expect(job(text, 'release')).toMatch(/permissions:\s*\n(\s+#.*\n)*\s+contents: write/);
    expect(text).not.toMatch(/(packages|actions|id-token|pull-requests|issues): write/);
  });

  test('a deploy in progress is never cancelled by the next push', () => {
    expect(text).toMatch(/concurrency:\s*\n\s+group: deploy\s*\n\s+cancel-in-progress: false/);
  });

  test('a rollback by hand deploys but never releases', () => {
    expect(job(text, 'release')).toContain("if: github.event_name == 'workflow_run'");
    expect(job(text, 'release')).toContain('needs: deploy');
  });

  test('a hand-started run only runs from main: another branch brings its own copy of this file', () => {
    expect(job(text, 'deploy')).toMatch(/github\.ref == 'refs\/heads\/main'/);
  });

  test('no expression is written into a shell: a value reaches it through env, quoted', () => {
    expect(runLines(text).filter((line) => line.includes('${{'))).toEqual([]);
  });

  test('every checkout leaves the token out of .git/config', () => {
    const checkouts = text.match(/uses: actions\/checkout@/g) ?? [];
    const guarded = text.match(/persist-credentials: false/g) ?? [];
    expect(checkouts.length).toBeGreaterThan(0);
    expect(guarded).toHaveLength(checkouts.length);
  });

  describe('the check that a hand-started commit is on main', () => {
    const script = stepRun(text, 'the commit is on main');
    const run = (status: string, commit: string): number => {
      const dir = mkdtempSync(join(tmpdir(), 'on-main-'));
      try {
        writeFileSync(join(dir, 'gh'), `#!/usr/bin/env bash\necho "$STATUS"\n`);
        chmodSync(join(dir, 'gh'), 0o755);
        writeFileSync(join(dir, 'step.sh'), `set -euo pipefail\n${script}\n`);
        return Bun.spawnSync(['bash', join(dir, 'step.sh')], {
          stdout: 'pipe',
          stderr: 'pipe',
          env: {
            PATH: `${dir}:${process.env['PATH'] ?? ''}`,
            STATUS: status,
            COMMIT: commit,
            GH_TOKEN: 'x',
            REPOSITORY: 'acme/purlay',
          },
        }).exitCode;
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };
    const good = 'a'.repeat(40);

    test.each(['behind', 'identical'])(
      'lets %s through: an ancestor of main, or main',
      (status) => {
        expect(run(status, good)).toBe(0);
      },
    );

    test.each(['ahead', 'diverged', ''])('refuses %p: not on main', (status) => {
      expect(run(status, good)).not.toBe(0);
    });

    test.each(['main', 'HEAD~1', `${good}; echo`, 'a'.repeat(39)])(
      'refuses %p before it asks GitHub anything: not a full commit hash',
      (commit) => {
        expect(run('identical', commit)).not.toBe(0);
      },
    );
  });

  test('a commit named by hand is judged before it is checked out', () => {
    const judged = text.indexOf('the commit is on main');
    const checkedOut = text.indexOf('actions/checkout');
    expect(judged).toBeGreaterThan(-1);
    expect(judged).toBeLessThan(checkedOut);
  });
});
