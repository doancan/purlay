/**
 * A fenced diff in a message (#80, D-133), as a reader meets it: drawn as a diff — numbered lines,
 * added and removed said in words as well as colour — unified or split by the reader's choice,
 * counted, copied as it was sent, clamped above twelve lines; and any other language still a code
 * block.
 */
import { describe, expect, test } from 'bun:test';
import { within } from '@testing-library/react';
import { expectNoAxeViolations } from '../../testing/axe';
import { installDom } from '../../testing/dom';
import { renderApp } from '../../testing/render';
import { person } from '../../testing/user';
import { Toaster } from '../../ui/toast';
import { CLAMP_ABOVE_LINES } from './code-block';
import { ContentPortsContext, type ContentPorts } from './content-ports';
import { renderContent } from './render-content';

installDom();

const DIFF = [
  '--- a/src/retry.ts',
  '+++ b/src/retry.ts',
  '@@ -10,3 +10,4 @@',
  ' const base = 1000;',
  '-const cap = 4000;',
  '+const cap = 8000;',
  '+const jitter = 0.2;',
  ' return n;',
].join('\n');

const mount = async (
  content: string,
  ports: Partial<ContentPorts> = {},
  locale?: 'en' | 'tr',
): ReturnType<typeof renderApp> =>
  await renderApp(
    <ContentPortsContext.Provider
      value={{ highlight: () => Promise.resolve(null), copy: () => Promise.resolve(), ...ports }}
    >
      <Toaster dismissLabel="Close" />
      {renderContent(content, {})}
    </ContentPortsContext.Provider>,
    locale === undefined ? {} : { locale },
  );

const rows = (view: { container: HTMLElement }, kind: string): string[] =>
  [...view.container.querySelectorAll(`tbody:not(.hidden) [data-diff-line="${kind}"]`)].map(
    (row) => row.textContent,
  );

describe('a diff in a message', () => {
  test('is drawn unified: numbered, each line marked, added and removed said in words', async () => {
    const view = await mount(`\`\`\`diff\n${DIFF}\n\`\`\``);
    expect(view.getByText('src/retry.ts')).toBeDefined();
    expect(view.getByText('+2')).toBeDefined();
    expect(view.getByText('−1')).toBeDefined();
    expect(rows(view, 'removed')).toEqual(['11removed-const cap = 4000;']);
    expect(rows(view, 'added')).toEqual([
      '11added+const cap = 8000;',
      '12added+const jitter = 0.2;',
    ]);
    expect(rows(view, 'context')[0]).toBe('1010 const base = 1000;');
    expect(view.getByRole('region', { name: 'Diff, 2 added, 1 removed' })).toBeDefined();
    expect(view.getByRole('button', { name: 'Unified' }).getAttribute('aria-pressed')).toBe('true');
    await expectNoAxeViolations(view.container);
    view.unmount();
  });

  test('split, the old side beside the new, each removal against the addition after it', async () => {
    const view = await mount(`\`\`\`diff\n${DIFF}\n\`\`\``);
    await person().click(view.getByRole('button', { name: 'Split' }));
    expect(view.getByRole('button', { name: 'Split' }).getAttribute('aria-pressed')).toBe('true');
    const split = view.container.querySelectorAll('tbody.max-narrow\\:hidden tr');
    const cells = [...split].map((row) =>
      [...row.querySelectorAll('td')].map((cell) => cell.textContent),
    );
    expect(cells).toContainEqual([
      '11',
      'removed-const cap = 4000;',
      '11',
      'added+const cap = 8000;',
    ]);
    expect(cells).toContainEqual(['', '', '12', 'added+const jitter = 0.2;']);
    // Context is on both sides, at its number on each.
    expect(cells).toContainEqual(['10', ' const base = 1000;', '10', ' const base = 1000;']);
    // Below an addition the two sides part: each at its own number.
    expect(cells).toContainEqual(['12', ' return n;', '13', ' return n;']);
    // One set of column names at a time: the split view's four.
    const heads = view.container.querySelectorAll('thead:not(.hidden) th');
    expect([...heads].map((head) => head.textContent)).toEqual([
      'Old line',
      'Line',
      'New line',
      'Line',
    ]);
    // The unified lines stay for a narrow window, where there is room for one column only.
    expect(view.container.querySelector('tbody.hidden')).not.toBeNull();
    await expectNoAxeViolations(view.container);
    view.unmount();
  });

  test('a patch is a diff too; any other language is a code block', async () => {
    const patch = await mount(`\`\`\`patch\n${DIFF}\n\`\`\``);
    expect(patch.getByRole('button', { name: 'Unified' })).toBeDefined();
    patch.unmount();
    const ts = await mount('```ts\nconst x = 1;\n```');
    expect(ts.queryByRole('button', { name: 'Unified' })).toBeNull();
    expect(ts.getByRole('button', { name: 'Copy code' })).toBeDefined();
    ts.unmount();
  });

  test('copies exactly what was sent', async () => {
    const copied: string[] = [];
    const view = await mount(`\`\`\`diff\n${DIFF}\n\`\`\``, {
      copy: (text) => {
        copied.push(text);
        return Promise.resolve();
      },
    });
    await person().click(view.getByRole('button', { name: 'Copy code' }));
    expect(copied).toEqual([DIFF]);
    view.unmount();
  });

  test('a clipboard the browser refuses is said', async () => {
    const view = await mount(`\`\`\`diff\n${DIFF}\n\`\`\``, {
      copy: () => Promise.reject(new Error('denied')),
    });
    await person().click(view.getByRole('button', { name: 'Copy code' }));
    expect(
      await view.findByText("Couldn't copy. Select the text and copy it yourself."),
    ).toBeDefined();
    view.unmount();
  });

  test('above twelve lines it is clamped, and opened to show them all', async () => {
    const long = Array.from({ length: CLAMP_ABOVE_LINES + 3 }, (_, n) => `+line ${String(n)}`).join(
      '\n',
    );
    const view = await mount(`\`\`\`diff\n${long}\n\`\`\``);
    const region = view.getByRole('region', { name: /^Diff/ });
    expect(region.className).toContain('max-h-code');
    expect(region.hasAttribute('tabindex')).toBe(false);
    const more = view.getByRole('button', {
      name: `Show all ${String(CLAMP_ABOVE_LINES + 3)} lines`,
    });
    await person().click(more);
    expect(region.className).not.toContain('max-h-code');
    expect(region.getAttribute('tabindex')).toBe('0');
    expect(more.getAttribute('aria-expanded')).toBe('true');
    view.unmount();
  });

  test('git says what a hunk cannot: a rename and a missing newline are rows, not lost', async () => {
    const renamed = [
      'diff --git a/old.ts b/new.ts',
      'similarity index 90%',
      'rename from old.ts',
      'rename to new.ts',
      '--- a/old.ts',
      '+++ b/new.ts',
      '@@ -1 +1 @@',
      '-a',
      '\\ No newline at end of file',
      '+b',
    ].join('\n');
    const view = await mount(`\`\`\`diff\n${renamed}\n\`\`\``);
    expect(view.getByText('new.ts')).toBeDefined();
    expect(rows(view, 'note')).toEqual([
      'similarity index 90%',
      'rename from old.ts',
      'rename to new.ts',
      '\\ No newline at end of file',
    ]);
    // The paths are headers, never rows.
    expect(view.container.textContent).not.toContain('+++ b/new.ts');
    view.unmount();
  });

  test('its columns are named, and the words a screen reader hears are never copied', async () => {
    const view = await mount(`\`\`\`diff\n${DIFF}\n\`\`\``);
    const heads = [...view.container.querySelectorAll('thead:not(.max-narrow\\:hidden) th')];
    expect(heads.map((head) => head.textContent)).toEqual(['Old line', 'New line', 'Line']);
    for (const word of view.getAllByText('added')) expect(word.className).toContain('select-none');
    view.unmount();
  });

  test('an empty diff fence is drawn as the code block it would otherwise be', async () => {
    const view = await mount('```diff\n```');
    expect(view.queryByRole('button', { name: 'Unified' })).toBeNull();
    expect(view.getByRole('button', { name: 'Copy code' })).toBeDefined();
    view.unmount();
  });

  test('in Turkish, it speaks Turkish', async () => {
    const view = await mount(`\`\`\`diff\n${DIFF}\n\`\`\``, {}, 'tr');
    expect(view.getByRole('button', { name: 'Yan yana' })).toBeDefined();
    expect(within(view.container).getAllByText('eklendi')).toHaveLength(2);
    view.unmount();
  });
});
