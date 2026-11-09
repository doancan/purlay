/** Publishing tested releases never needs access to a production server. */
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

describe('the events that can publish a release', () => {
  test('the reader finds the events', () => {
    expect(
      events('name: x\non:\n  push:\n    branches: [main]\n  workflow_dispatch:\n\njobs:\n'),
    ).toEqual(['push', 'workflow_dispatch']);
    expect(events('name: x\n')).toEqual([]);
  });

  test('publication starts after a main push or a manual retry, and nothing else', () => {
    expect(events(read('deploy.yml'))).toEqual(['workflow_run', 'workflow_dispatch']);
    expect(read('deploy.yml')).toContain('workflows: [ci, image]');
    expect(read('deploy.yml')).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(read('deploy.yml')).toContain("github.event.workflow_run.event == 'push'");
    expect(read('deploy.yml')).toContain('head_repository.full_name == github.repository');
  });

  test('no workflow requires a self-hosted runner', () => {
    const onTheServer = names.filter((name) => /self-hosted|purlay-server/.test(read(name)));
    expect(onTheServer).toEqual([]);
  });
});

describe('what release publication is allowed', () => {
  const text = read('deploy.yml');

  test('publication runs on GitHub and checks out the gated commit', () => {
    expect(job(text, 'gate')).toContain('runs-on: ubuntu-latest');
    expect(job(text, 'release')).toContain('runs-on: ubuntu-latest');
    expect(job(text, 'release')).toContain('ref: ${{ needs.gate.outputs.commit }}');
    expect(job(text, 'release')).toMatch(/permissions:\s*\n(\s+#.*\n)*\s+contents: write/);
    expect(text).not.toMatch(/(packages|actions|id-token|pull-requests|issues): write/);
    expect(text).not.toContain('scripts/deploy.sh');
  });

  test('publication in progress is never cancelled by the next push', () => {
    expect(text).toMatch(/concurrency:\s*\n\s+group: deploy\s*\n\s+cancel-in-progress: false/);
  });

  test('publication can be retried by hand, but always requires a successful gate', () => {
    expect(job(text, 'release')).toContain('needs: gate');
    expect(job(text, 'release')).toContain("if: needs.gate.outputs.ready == 'true'");
    expect(job(text, 'gate')).toContain(
      'commit: ${{ inputs.commit || github.event.workflow_run.head_sha || github.sha }}',
    );
  });

  test('a hand-started run only runs from main: another branch brings its own copy of this file', () => {
    expect(job(text, 'gate')).toMatch(/github\.ref == 'refs\/heads\/main'/);
  });

  test('only the hosted gate reads workflow runs', () => {
    expect(job(text, 'gate')).toContain('actions: read');
    expect(job(text, 'release')).not.toContain('actions: read');
  });

  describe('the gate: the commit passed ci and published its image (#798)', () => {
    const script = stepRun(text, 'the commit passed ci and published its image');
    const good = 'b'.repeat(40);
    /** What the gate does when `ci` and `image` report these `status conclusion` lines. */
    const gate = (
      ci: string,
      image: string,
      byHand = false,
      commit = good,
    ): { readonly code: number; readonly ready: string; readonly asked: string } => {
      const dir = mkdtempSync(join(tmpdir(), 'gate-'));
      try {
        writeFileSync(
          join(dir, 'gh'),
          `#!/usr/bin/env bash\necho "$*" >> "$ASKED"\ncase "$*" in *ci.yml*) echo "$CI" ;; *image.yml*) echo "$IMAGE" ;; esac\n`,
        );
        chmodSync(join(dir, 'gh'), 0o755);
        writeFileSync(join(dir, 'step.sh'), `set -euo pipefail\n${script}\n`);
        writeFileSync(join(dir, 'output'), '');
        writeFileSync(join(dir, 'asked'), '');
        const code = Bun.spawnSync(['bash', join(dir, 'step.sh')], {
          stdout: 'pipe',
          stderr: 'pipe',
          env: {
            PATH: `${dir}:${process.env['PATH'] ?? ''}`,
            CI: ci,
            IMAGE: image,
            COMMIT: commit,
            BY_HAND: String(byHand),
            GH_TOKEN: 'x',
            REPOSITORY: 'acme/purlay',
            GITHUB_OUTPUT: join(dir, 'output'),
            ASKED: join(dir, 'asked'),
          },
        }).exitCode;
        return {
          code,
          ready: readFileSync(join(dir, 'output'), 'utf8').trim(),
          asked: readFileSync(join(dir, 'asked'), 'utf8'),
        };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };

    test('both succeeded: it permits publication', () => {
      expect(gate('completed success', 'completed success')).toMatchObject({
        code: 0,
        ready: 'ready=true',
      });
    });

    test("it asks about this commit's push runs on main, of both workflows", () => {
      const { asked } = gate('completed success', 'completed success');
      for (const workflow of ['ci.yml', 'image.yml']) {
        expect(asked).toContain(
          `repos/acme/purlay/actions/workflows/${workflow}/runs?head_sha=${good}&event=push&branch=main`,
        );
      }
    });

    test.each([
      ['in_progress ', 'completed success'],
      ['completed success', 'queued '],
      ['waiting ', 'in_progress '],
    ])('one still running (ci %p, image %p): it waits, and does not fail', (ci, image) => {
      expect(gate(ci, image)).toMatchObject({ code: 0, ready: 'ready=false' });
    });

    test.each([
      ['completed failure', 'completed success'],
      ['completed success', 'completed cancelled'],
      ['completed timed_out', 'completed success'],
      ['null null', 'completed success'],
      ['completed success', 'null null'],
    ])('one that did not succeed or never ran (ci %p, image %p) refuses', (ci, image) => {
      expect(gate(ci, image)).toMatchObject({ code: 1, ready: '' });
    });

    test('a failure refuses even while the other is still running', () => {
      expect(gate('completed failure', 'in_progress ').code).toBe(1);
      expect(gate('in_progress ', 'completed failure').code).toBe(1);
    });

    test('a manual retry cannot wait, so a run still going refuses it', () => {
      expect(gate('in_progress ', 'completed success', true)).toMatchObject({ code: 1, ready: '' });
      expect(gate('completed success', 'completed success', true).code).toBe(0);
    });

    test.each(['main', `${good}; echo`, 'b'.repeat(39)])(
      'refuses %p before it asks GitHub anything',
      (commit) => {
        const { code, asked } = gate('completed success', 'completed success', false, commit);
        expect(code).toBe(1);
        expect(asked).toBe('');
      },
    );
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

describe('release image promotion', () => {
  const text = read('release-image.yml');

  test('checks out the published release, independently of a later main tip', () => {
    expect(text).toContain('ref: ${{ steps.release.outputs.tag }}');
    expect(text).not.toContain('ref: ${{ github.event.workflow_run.head_sha');
    expect(text).toContain("if: steps.release.outputs.tag != ''");
  });

  const select = (
    answer: string,
    code = 0,
    tag = '',
  ): { code: number; output: string; asked: string } => {
    const dir = mkdtempSync(join(tmpdir(), 'release-select-'));
    try {
      writeFileSync(
        join(dir, 'gh'),
        '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$ASKED"\nprintf "%s\\n" "$ANSWER"\nexit "$CODE"\n',
      );
      chmodSync(join(dir, 'gh'), 0o755);
      writeFileSync(
        join(dir, 'step.sh'),
        `set -euo pipefail\n${stepRun(text, 'select the published release')}\n`,
      );
      writeFileSync(join(dir, 'output'), '');
      writeFileSync(join(dir, 'asked'), '');
      const result = Bun.spawnSync(['bash', join(dir, 'step.sh')], {
        stdout: 'pipe',
        stderr: 'pipe',
        env: {
          PATH: `${dir}:${process.env['PATH'] ?? ''}`,
          ANSWER: answer,
          CODE: String(code),
          TAG: tag,
          REPOSITORY: 'acme/purlay',
          GITHUB_OUTPUT: join(dir, 'output'),
          ASKED: join(dir, 'asked'),
        },
      });
      return {
        code: result.exitCode,
        output: readFileSync(join(dir, 'output'), 'utf8').trim(),
        asked: readFileSync(join(dir, 'asked'), 'utf8'),
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  test('an automatic run selects the latest published release even when main has advanced', () => {
    const result = select('v0.5.0');
    expect(result).toMatchObject({ code: 0, output: 'tag=v0.5.0' });
    expect(result.asked).toContain('release view --repo acme/purlay');
  });

  test('before the first release it does nothing', () => {
    expect(select('release not found', 1)).toMatchObject({ code: 0, output: '' });
  });

  test('an unavailable GitHub refuses promotion', () => {
    expect(select('HTTP 503', 1)).toMatchObject({ code: 1, output: '' });
  });

  test.each(['main', 'v1.2.3;echo', 'v1.2.3-rc.1', ''])(
    'refuses an invalid published tag %p',
    (answer) => {
      expect(select(answer)).toMatchObject({ code: 1, output: '' });
    },
  );

  test('a manual retry keeps the chosen tag for the script to validate against latest', () => {
    expect(select('unused', 0, 'v0.5.0')).toEqual({ code: 0, output: 'tag=v0.5.0', asked: '' });
  });
});
