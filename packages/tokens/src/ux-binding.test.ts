/**
 * `UX.md` states numbers the tokens also hold. One of them is the owner.
 *
 * The tokens own them (`docs/OVERVIEW.md`); `UX.md` keeps them because a layout
 * diagram without its widths is not a layout diagram. A second copy is allowed to
 * exist only if a check fails when it drifts (`CONTRIBUTING.md` §6.1) — so this is
 * that check: change a width in `tokens.json` and not in `UX.md`, or the reverse,
 * and the build says so.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { parseTokens } from './model';

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');
const parsed = parseTokens(JSON.parse(read('../tokens.json')));
if (!parsed.ok) throw new Error(parsed.problems.join('\n'));
const model = parsed.model;
const ux = read('../../../docs/UX.md');

const valueOf = (name: string): string => {
  const token = [...model.size, ...model.radius].find((entry) => entry.name === name);
  if (token === undefined) throw new Error(`no token ${name}`);
  return token.value;
};

describe('UX.md §2 layout', () => {
  test.each([
    ['size-rail', 'Workspace switcher'],
    ['size-sidebar', 'Sidebar'],
    ['size-members', '200px'],
    ['size-feed-max', 'Max width'],
    ['size-narrow', 'Below'],
  ])('%s is the width UX.md states', (name, anchor) => {
    const line = ux.split('\n').find((candidate) => candidate.includes(anchor));
    expect(line, `UX.md has no line with "${anchor}"`).toBeDefined();
    expect(line).toContain(valueOf(name));
  });

  test('states no other px width in that section', () => {
    const section = ux.slice(ux.indexOf('## 2. Layout'), ux.indexOf('## 3.'));
    const stated = new Set(section.match(/\b\d+px\b/g));
    const owned = new Set(
      ['size-rail', 'size-sidebar', 'size-members', 'size-feed-max', 'size-narrow'].map(valueOf),
    );
    expect([...stated].filter((value) => !owned.has(value))).toEqual([]);
  });
});

describe('UX.md §9 visual system', () => {
  const section = ux.slice(ux.indexOf('## 9. Visual system'));
  const style = (name: string): { size: string; leading: number } => {
    const found = model.text.find((entry) => entry.name === name);
    if (found === undefined) throw new Error(`no text style ${name}`);
    return { size: found.size, leading: found.leading };
  };

  test('base type size and line height are the body style', () => {
    const body = style('body');
    expect(section).toContain(`Base ${body.size}`);
    expect(section).toContain(String(body.leading));
  });

  test('code size and line height are the code style', () => {
    const code = style('code');
    expect(section).toContain(`code ${code.size}`);
    expect(section).toContain(String(code.leading));
  });

  test('the radius is the working radius', () => {
    expect(section).toContain(valueOf('radius-md'));
  });
});
