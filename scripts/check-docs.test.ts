/**
 * The document check can fail.
 *
 * For its whole life before #193 it printed what it found and exited 0, so the
 * `documents` job and `verify` reported success for every repository state. A
 * gate is only evidence once it has been seen to refuse (`CONTRIBUTING.md` §6.4),
 * so each class of defect it exists for is planted in a copy and must turn the
 * exit status red — and the untouched copy must stay green, or "red" would mean
 * nothing either.
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Each test copies every tracked file and runs the whole check on the copy, which takes the better part of
 * a second alone and several under the load of the full suite — more than the runner's five seconds, which
 * failed a job and a local run for no fault of the check. The limit is the one a test that does this needs.
 */
setDefaultTimeout(60_000);

/** Written in two parts, so that this file does not itself cite a decision or a section that does not exist. */
const DECISION = 'D-';
const SECTION = '§';

const SCRIPT = resolve('scripts/check-docs.py');
const copies: string[] = [];

afterAll(() => {
  for (const copy of copies) rmSync(copy, { recursive: true, force: true });
});

/**
 * Every tracked file. Not only the documents: a link may point at any file, and a
 * copy missing one would fail the check for a reason no test here is about.
 */
const aCopy = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'check-docs-'));
  copies.push(root);
  const tracked = Bun.spawnSync(['git', 'ls-files']).stdout.toString().trim().split('\n');
  for (const file of tracked) cpSync(file, join(root, file));
  return root;
};

const edit = (root: string, file: string, change: (text: string) => string): void => {
  const path = join(root, file);
  const before = readFileSync(path, 'utf8');
  const after = change(before);
  // An edit that matched nothing would make the red result below mean nothing.
  expect(after).not.toBe(before);
  writeFileSync(path, after);
};

const run = (root: string): { status: number; output: string } => {
  const result = Bun.spawnSync(['python3', SCRIPT], { cwd: root });
  return { status: result.exitCode, output: result.stdout.toString() };
};

describe('the document check', () => {
  test('passes on the repository as it is', () => {
    const { status, output } = run(aCopy());
    expect({ status, output }).toEqual({
      status: 0,
      output: expect.stringContaining('[ok]') as string,
    });
  });

  test("does not read a person's own tooling directories, which no clone has and no commit carries", () => {
    const root = aCopy();
    // What an agent's notes on one machine look like: a pinned version, a stale count, a conflict marker.
    for (const dir of ['.superpowers/sdd/plan', '.superdesign/notes', '.swarm/log']) {
      mkdirSync(join(root, dir), { recursive: true });
      writeFileSync(
        join(root, dir, 'report.md'),
        `Bun 1.4.3 was used. It claims 9 decisions.\n${'<'.repeat(7)} HEAD\n`,
      );
    }
    const { status, output } = run(root);
    expect({ status, output }).toEqual({
      status: 0,
      output: expect.stringContaining('[ok]') as string,
    });
  });

  test('fails on a citation of a decision that does not exist', () => {
    const root = aCopy();
    // Built from pieces so this file is not itself a source that cites a decision that does not exist.
    const missing = `${DECISION}999`;
    edit(root, 'docs/PRD.md', (text) => `${text}\nSee ${missing}.\n`);
    const { status, output } = run(root);
    expect(status).toBe(1);
    expect(output).toContain(missing);
  });

  test('fails on a path a document names that does not exist', () => {
    const root = aCopy();
    edit(
      root,
      'docs/OVERVIEW.md',
      (text) => `${text}\nSee \`apps/api/src/ingress/http/messages.ts\`.\n`,
    );
    const { status, output } = run(root);
    expect(status).toBe(1);
    expect(output).toContain('a document names a path that does not exist');
    expect(output).toContain('apps/api/src/ingress/http/messages.ts');
  });

  test('fails on a figure of seven digits stated in a second document, whichever figure it is', () => {
    const root = aCopy();
    // 26214400 is the attachment cap SCHEMA.md owns; 99999999 is one no document has, stated twice.
    edit(
      root,
      'docs/API.md',
      (text) => `${text}\nThe cap is 26214400 bytes, and 99999999 is another.\n`,
    );
    edit(root, 'docs/UX.md', (text) => `${text}\nAnd 99999999 again.\n`);
    const { status, output } = run(root);
    expect(status).toBe(1);
    expect(output).toContain('a figure is stated in more than one document');
    expect(output).toContain('26214400');
    expect(output).toContain('99999999');
  });

  test('fails on a gap in decision numbering', () => {
    const root = aCopy();
    edit(root, 'docs/DECISIONS.md', (text) => text.replace(/^### D-2\. /m, '### Formerly D-2. '));
    const { status, output } = run(root);
    expect(status).toBe(1);
    expect(output).toContain('D-numbering has a gap');
  });

  test('fails on an unresolved merge conflict, in any tracked file', () => {
    const root = aCopy();
    // Built from pieces so this file does not itself contain what the check refuses.
    const marker = `${'<'.repeat(7)} HEAD`;
    edit(root, 'docs/CONFIG.md', (text) => `${text}\n${marker}\nours\n`);
    const { status, output } = run(root);
    expect(status).toBe(1);
    expect(output).toContain('unresolved merge conflict marker');
    expect(output).toContain('docs/CONFIG.md');
  });

  test('fails when decisions are out of order, which the count cannot see', () => {
    const root = aCopy();
    edit(root, 'docs/DECISIONS.md', (text) =>
      text.replace(/^## Part D/m, '### D-1. A late copy\n\n## Part D'),
    );
    const { status, output } = run(root);
    expect(status).toBe(1);
    expect(output).toContain('decisions are out of order');
  });

  test('fails when a migration file is missing from SCHEMA.md', () => {
    const root = aCopy();
    edit(root, 'docs/SCHEMA.md', (text) =>
      text.replace(/^0007_message_content_limit\.sql.*$/m, ''),
    );
    const { status, output } = run(root);
    expect(status).toBe(1);
    expect(output).toContain('0007_message_content_limit.sql');
  });

  test('fails when a module’s migration is missing from SCHEMA.md, or SCHEMA.md names one that is not a file (D-250)', () => {
    const missing = aCopy();
    edit(missing, 'docs/SCHEMA.md', (text) =>
      text.replace(/^chat\/0001_message_attachments\.sql.*$/m, ''),
    );
    const left = run(missing);
    expect(left.status).toBe(1);
    expect(left.output).toContain('chat/0001_message_attachments.sql');

    const invented = aCopy();
    edit(invented, 'docs/SCHEMA.md', (text) =>
      text.replace(
        /^(chat\/0001_message_attachments\.sql.*)$/m,
        '$1\nchat/0002_a_file_nobody_wrote.sql  nothing',
      ),
    );
    const named = run(invented);
    expect(named.status).toBe(1);
    expect(named.output).toContain('chat/0002_a_file_nobody_wrote.sql');
  });

  describe('the decision record', () => {
    // One past the last decision, spelled so that the source citation check does not read it as a citation of one that is not there.
    const NEXT = 296;
    const append = (text: string): ReturnType<typeof run> => {
      const root = aCopy();
      edit(root, 'docs/DECISIONS.md', (before) => `${before}\n${text}\n`);
      return run(root);
    };
    const decision = (header: string, body = '**Cost of reversing.** None.'): string =>
      `### D-${String(NEXT)}. ${header}\n\n${body}`;

    test('fails when a decision amends another that does not point back', () => {
      const { status, output } = append(decision('A change — amends D-5'));
      expect(status).toBe(1);
      expect(output).toContain('a decision amends another that does not name it');
    });

    test('passes an amendment the amended decision names', () => {
      const root = aCopy();
      edit(
        root,
        'docs/DECISIONS.md',
        (text) =>
          `${text.replace(/(^### D-5\. .*$)/m, `$1\n\n*Amended by D-${String(NEXT)}: x.*`)}\n${decision('A change — amends D-5')}\n`,
      );
      expect(run(root).output).not.toContain('does not name it');
    });

    test('fails when a decision since the platform began has no cost of reversing', () => {
      const { status, output } = append(decision('A change', '**Context.** It happened.'));
      expect(status).toBe(1);
      expect(output).toContain('a decision has no cost of reversing');
    });

    test('fails when a decision sits under the open questions', () => {
      const root = aCopy();
      edit(root, 'docs/DECISIONS.md', (text) =>
        text.replace('## Part E — ', `${decision('Misplaced')}\n\n## Part E — `),
      );
      const { status, output } = run(root);
      expect(status).toBe(1);
      expect(output).toContain('a decision is filed under the open questions');
    });
  });

  describe('links', () => {
    const plant = (file: string, link: string): ReturnType<typeof run> => {
      const root = aCopy();
      edit(root, file, (text) => `${text}\n${link}\n`);
      return run(root);
    };

    test('fails on a link to a heading that is not in the document it names', () => {
      const { status, output } = plant('docs/OVERVIEW.md', '[x](MODULES.md#no-such-heading)');
      expect(status).toBe(1);
      expect(output).toContain('a link names a heading that is not there');
      expect(output).toContain('MODULES.md#no-such-heading');
    });

    test('fails on an anchor in the same document that is not a heading', () => {
      const { output } = plant('docs/OVERVIEW.md', '[x](#no-such-heading)');
      expect(output).toContain('a link names a heading that is not there');
    });

    test('passes a link to a heading, as GitHub spells it, and to the split-off history', () => {
      const { status, output } = plant(
        'docs/OVERVIEW.md',
        '[a](MODULES.md#8-what-holds-each-rule) [b](MODULES-HISTORY.md#measurements-behind-the-rules-of-7) [c](#read-in-this-order)',
      );
      expect({ status, output: output.includes('a link names') }).toEqual({
        status: 0,
        output: false,
      });
    });
  });

  describe('retired claims (D-255)', () => {
    const plant = (file: string, sentence: string): ReturnType<typeof run> => {
      const root = aCopy();
      edit(root, file, (text) => `${text}\n${sentence}\n`);
      return run(root);
    };

    test.each([
      ['a node that refuses to serve beside a peer', 'docs/MODULES.md'],
      ['nodes of different sets share no bus channel', 'docs/CONFIG.md'],
      ['the hooks are held only while it runs', 'docs/MODULES.md'],
      ['`GET /api/client` lists the modules the server runs', 'docs/API.md'],
      ['`MODULES.md` §9 steps 6–9 do it', 'docs/ARCHITECTURE.md'],
      ['a disabled module is never mounted', 'docs/OVERVIEW.md'],
      ['the first 77 files create chat’s tables', 'docs/MODULES.md'],
      ['a module sets `dataInCore: true` and gives its hooks', 'docs/MODULES.md'],
      ['every bundled module with `dataInCore` is held', 'docs/CONFIG.md'],
      ['the compose work may remove this flag', 'docs/OVERVIEW.md'],
      ['so "no oracle" is exact for paths, bodies and codes', 'docs/MODULES.md'],
      ['so the public handshake adds nothing to what a closed route’s 404 hides', 'docs/API.md'],
      ['until then isolation by budget is intent', 'docs/MODULES.md'],
      ['nothing outside its tests imports it, so no process takes it', 'docs/MODULES.md'],
      ['rows below are not built until the step named', 'docs/MODULES.md'],
      ['Nothing holds either, and neither is worth a guard', 'docs/MODULES.md'],
    ])('fails on %s', (sentence, file) => {
      const { status, output } = plant(file, sentence);
      expect(status).toBe(1);
      expect(output).toContain('a retired claim is back');
      expect(output).toContain(file);
    });

    test('leaves the decision record alone where it quotes what it amends', () => {
      // D-250 rule 8 still says "refuses to serve", under a note that D-255 amended it.
      const { status, output } = plant(
        'docs/DECISIONS.md',
        '\nA note: it refuses to serve, as D-250 first said.',
      );
      expect({ status, output }).toEqual({
        status: 0,
        output: expect.stringContaining('[ok]') as string,
      });
    });

    test('does not read the changelog, which is history', () => {
      const { status } = plant('docs/changelog/changes.md', 'A node refuses to serve.');
      expect(status).toBe(0);
    });
  });

  describe('citations in source code', () => {
    const plantSource = (text: string): ReturnType<typeof run> => {
      const root = aCopy();
      writeFileSync(join(root, 'apps/api/src/planted-citation.ts'), `// ${text}\nexport {};\n`);
      return run(root);
    };

    test('fails on a section of a document that does not exist', () => {
      const { status, output } = plantSource(`see \`MODULES.md\` ${SECTION}99`);
      expect(status).toBe(1);
      expect(output).toContain('source cites a section that does not exist');
      expect(output).toContain(`apps/api/src/planted-citation.ts -> MODULES.md ${SECTION}99`);
    });

    test('fails on a decision that does not exist', () => {
      const { status, output } = plantSource(`see ${DECISION}998`);
      expect(status).toBe(1);
      expect(output).toContain('source cites a decision that does not exist');
      expect(output).toContain(`${DECISION}998`);
    });

    test('passes a citation that resolves', () => {
      const { status } = plantSource('see `MODULES.md` §12 and D-255');
      expect(status).toBe(0);
    });
  });

  describe('the modules the build carries (D-250)', () => {
    test('fails when ARCHITECTURE.md’s features tree does not name one', () => {
      const root = aCopy();
      edit(root, 'docs/ARCHITECTURE.md', (text) =>
        text.replace('└── issues/', '└── issue-tracker/'),
      );
      const { status, output } = run(root);
      expect(status).toBe(1);
      expect(output).toContain('a bundled module is missing from ARCHITECTURE.md');
      expect(output).toContain('issues');
    });

    test('fails when CONFIG.md’s MODULES row does not name one', () => {
      const root = aCopy();
      edit(root, 'docs/CONFIG.md', (text) => text.replace('`chat`, `issues`', '`chat`'));
      const { status, output } = run(root);
      expect(status).toBe(1);
      expect(output).toContain('a bundled module is missing from CONFIG.md');
      expect(output).toContain('issues');
    });

    test('fails when a module is bundled and no document knows it', () => {
      const root = aCopy();
      edit(root, 'apps/api/src/composition.ts', (text) =>
        text.replace('  issuesModule,\n', '  issuesModule,\n  zzfixtureModule,\n'),
      );
      const { status, output } = run(root);
      expect(status).toBe(1);
      expect(output).toContain('zzfixture');
    });
  });
});
