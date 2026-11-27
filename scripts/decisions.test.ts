/**
 * The decision record's index and numbering (`scripts/decisions.ts`, D-345).
 */
import { afterAll, describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CATEGORIES,
  draft,
  fileName,
  isCategory,
  main,
  nextNumber,
  withCount,
  parseDecision,
  readRecord,
  RECORD,
  renderIndex,
  slugOf,
  withIndex,
} from './decisions';

/** Spelled in two parts so this file does not cite decisions that do not exist (`check-docs.py`). */
const D = 'D-';

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const aRecord = (files: Record<string, string>): string => {
  const root = mkdtempSync(join(tmpdir(), 'decisions-'));
  roots.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
};

describe('a decision file', () => {
  test('is named by its number and a few words of its title', () => {
    expect(
      slugOf('The account door reads as a menu, and "you are here" has one tone — amends D-124'),
    ).toBe('account-door-reads-as-menu-you-here');
    expect(slugOf('Türkçe başlık: Çalışma alanı')).toBe('turkce-baslik-calisma-alani');
    expect(fileName(7, 'two-ways')).toBe(`${D}7-two-ways.md`);
  });

  test('is read for its number, title, day and what it amends', () => {
    const decision = parseDecision(
      'web-ui',
      `${D}12-a-door.md`,
      `# ${D}12. A door — amends ${D}3, ${D}4\n\n**Decided (the owner, 2026-11-26).** Text.\n`,
    );
    expect(decision).toEqual({
      number: 12,
      title: `A door — amends ${D}3, ${D}4`,
      category: 'web-ui',
      path: `web-ui/${D}12-a-door.md`,
      decided: '2026-11-26',
      amends: [3, 4],
    });
  });

  test('amends each decision its title changes once, however it says so, and not one it only builds on', () => {
    const amends = (title: string): readonly number[] =>
      parseDecision('data', `${D}9-x.md`, `# ${D}9. ${title}\n`)?.amends ?? [];
    expect(amends(`A — supersedes S-1, amends ${D}1, ${D}4, ${D}1 §2`)).toEqual([1, 4]);
    expect(amends(`B — revises ${D}12`)).toEqual([12]);
    expect(amends(`C — builds on ${D}3; amends ${D}5`)).toEqual([5]);
    expect(amends(`D — extends ${D}6, answers ${D}7`)).toEqual([]);
    expect(amends('What changes when nothing is cited')).toEqual([]);
  });

  test('that builds on another does not count as amending it, and a file that is no decision is skipped', () => {
    expect(
      parseDecision('data', `${D}2-x.md`, `# ${D}2. X — builds on ${D}1\n\nNo date.`)?.amends,
    ).toEqual([]);
    expect(parseDecision('data', `${D}2-x.md`, `# ${D}2. X\n\nNo date.`)?.decided).toBeUndefined();
    expect(parseDecision('data', 'README.md', `# ${D}2. X`)).toBeUndefined();
    expect(parseDecision('data', `${D}2-x.md`, '# Something else')).toBeUndefined();
  });
});

describe('the record', () => {
  const root = aRecord({
    [`data/${D}2-second.md`]: `# ${D}2. Second — amends ${D}1\n\n**Decided (the owner, 2026-01-02).** On 2026-01-02.`,
    [`product/${D}1-first.md`]: `# ${D}1. First | with a bar\n\n*Amended by ${D}2: x.* Amended 2026-05-05.`,
    'product/notes.txt': 'not a decision',
    'README.md': 'x',
  });

  test('is read in number order across categories, and only from the categories', () => {
    expect(readRecord(root).map((decision) => decision.number)).toEqual([1, 2]);
    expect(nextNumber(readRecord(root))).toBe(3);
    expect(nextNumber([])).toBe(1);
  });

  test('is indexed by category, linking each file and naming what amended it', () => {
    const index = renderIndex(readRecord(root));
    expect(index).toContain(
      `| [${D}1](product/${D}1-first.md) | First \\| with a bar |  | ${D}2 |`,
    );
    expect(index).toContain(`| [${D}2](data/${D}2-second.md) | Second | 2026-01-02 |  |`);
    expect(index).toContain('### product (1)');
    expect(index).toContain('### mobile (0)');
    expect(index).toContain('2 decisions.');
  });

  test('replaces only what is between the markers, and refuses a README that lost them', () => {
    const index = renderIndex(readRecord(root));
    const [start, end] = [index.split('\n')[0]!, index.split('\n').at(-1)!];
    const readme = `# Before\n\n${start}\nold\n${end}\n\nAfter\n`;
    expect(withIndex(readme, index)).toBe(`# Before\n\n${index}\n\nAfter\n`);
    expect(() => withIndex('# No markers', index)).toThrow('lost its index markers');
  });

  test('escapes literal backslashes and pipes when writing a title to the table', () => {
    const path = `product/${D}1-first.md`;
    const title = String.raw`Path\| group | next`;
    const escapedTitle = String.raw`Path\\\| group \| next`;
    const record = aRecord({ [path]: `# ${D}1. ${title}` });
    expect(renderIndex(readRecord(record))).toContain(
      `| [${D}1](${path}) | ${escapedTitle} |  |  |`,
    );
  });
});

describe('a new decision', () => {
  test('is drafted from the template with its number, title and day', () => {
    const text = draft(500, 'A new thing', '2026-11-26');
    expect(text.startsWith(`# ${D}500. A new thing\n`)).toBe(true);
    expect(text).toContain('**Decided (the owner, 2026-11-26).**');
    expect(text).toContain('**Cost of reversing.**');
  });

  test("counts itself in the repository README's sentence about the record", () => {
    expect(withCount('| Why — 344 decisions, one file each |', 345)).toBe(
      '| Why — 345 decisions, one file each |',
    );
  });

  test('goes in a known category', () => {
    expect(isCategory('web-ui')).toBe(true);
    expect(isCategory('misc')).toBe(false);
    expect(CATEGORIES.length).toBe(9);
  });
});

describe("the repository's own record", () => {
  test('has an index that is what its files say', () => {
    const readme = readFileSync(join(RECORD, 'README.md'), 'utf8');
    expect(withIndex(readme, renderIndex(readRecord(RECORD)))).toBe(readme);
  });
});

describe('the decision commands', () => {
  const repositoryReadme = '# Purlay\n\nWhy — 1 decisions, one file each.\n';
  const document = (index: string): string => `# Decision record\n\n${index}\n\nKeep this prose.\n`;
  const repository = (): string =>
    aRecord({
      'README.md': repositoryReadme,
      [`${RECORD}/README.md`]: document(renderIndex([])),
      [`${RECORD}/_template.md`]: readFileSync(join(RECORD, '_template.md'), 'utf8'),
      [`${RECORD}/product/${D}1-first.md`]: `# ${D}1. First\n`,
    });

  test('index check refuses a stale index without writing, and regenerating it keeps the surrounding prose', () => {
    const root = repository();
    const readme = join(root, RECORD, 'README.md');
    const error = spyOn(console, 'error').mockImplementation(() => undefined);
    const out = spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      expect(main(['index', '--check'], root)).toBe(1);
      expect(error).toHaveBeenCalledWith(expect.stringContaining('is out of date'));
      expect(readFileSync(readme, 'utf8')).toBe(document(renderIndex([])));

      expect(main(['index'], root)).toBe(0);
      expect(out).toHaveBeenCalledWith('decisions index: wrote 1 decisions');
      const checked = readFileSync(readme, 'utf8');
      expect(checked).toBe(document(renderIndex(readRecord(join(root, RECORD)))));
      expect(checked).toContain(`| [${D}1](product/${D}1-first.md) | First |`);
      expect(main(['index', '--check'], root)).toBe(0);
      expect(out).toHaveBeenCalledWith('decisions index: 1 decisions, up to date');
      expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe(repositoryReadme);
    } finally {
      error.mockRestore();
      out.mockRestore();
    }
  });

  test('new writes the next decision from the repository template and updates the index and root count', () => {
    const root = repository();
    const destination = join(RECORD, 'data', `${D}2-second-record.md`);
    const out = spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      expect(main(['new', 'data', '  Second', 'record  '], root)).toBe(0);
      expect(out).toHaveBeenCalledWith(destination);
      const made = readFileSync(join(root, destination), 'utf8');
      expect(made).toStartWith(`# ${D}2. Second record\n`);
      expect(made).toMatch(/\*\*Decided \(the owner, \d{4}-\d{2}-\d{2}\)\.\*\*/);
      expect(readFileSync(join(root, RECORD, 'README.md'), 'utf8')).toContain(
        `| [${D}2](data/${D}2-second-record.md) | Second record |`,
      );
      expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe(
        repositoryReadme.replace('1 decisions', '2 decisions'),
      );
    } finally {
      out.mockRestore();
    }
  });

  test('refuses an unknown command, category or missing title without touching the record', () => {
    const root = repository();
    const record = join(root, RECORD);
    const error = spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(main(['publish'], root)).toBe(1);
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('usage: bun scripts/decisions.ts'),
      );
      for (const argv of [['new'], ['new', 'misc', 'Second'], ['new', 'data', '   ']]) {
        expect(main(argv, root)).toBe(1);
      }
      expect(error).toHaveBeenLastCalledWith(
        expect.stringContaining('usage: bun run decision:new'),
      );
      expect(readdirSync(record).sort()).toEqual(['README.md', '_template.md', 'product']);
      expect(readFileSync(join(record, 'README.md'), 'utf8')).toBe(document(renderIndex([])));
      expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe(repositoryReadme);
    } finally {
      error.mockRestore();
    }
  });
});
