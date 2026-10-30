/**
 * Reading an attached file in place (D-210): which files offer it, what it draws — a CSV's top rows as
 * a table, Markdown formatted, code in its language — and that the file is asked for only on request.
 */
import { describe, expect, test } from 'bun:test';
import { within } from '@testing-library/react';
import type { Attachment } from '@purlay/types';
import { expectNoAxeViolations } from '../../testing/axe';
import { installDom } from '../../testing/dom';
import { ME, aMessage, aSignedInApi } from '../../testing/fixtures';
import { renderApp } from '../../testing/render';
import { settle } from '../../testing/channel-harness';
import { person } from '../../testing/user';
import {
  PREVIEW_BYTES_MAX,
  previewMarkdown,
  previewOf,
  type PreviewKind,
} from './attachment-preview';
import { MessageRow } from './message-row';

installDom();

const file = (fileName: string, sizeBytes = 2048): Attachment => ({
  id: '01995f7b-0000-7000-8000-0000000000a1',
  fileName,
  mimeType: 'application/octet-stream',
  sizeBytes,
  kind: 'file',
  width: null,
  height: null,
});

describe('which files are read in place', () => {
  test.each<[string, PreviewKind]>([
    ['sales.csv', { kind: 'table' }],
    ['export.TSV', { kind: 'table' }],
    ['README.md', { kind: 'markdown' }],
    ['retry.ts', { kind: 'code', language: 'ts' }],
    ['schema.sql', { kind: 'code', language: 'sql' }],
    ['server.log', { kind: 'code', language: null }],
  ])('%s', (name, kind) => {
    expect(previewOf(name, 2048)).toEqual(kind);
  });

  test('a file of no text kind, with no extension, or too large to read at once is a download only', () => {
    expect(previewOf('report.pdf', 2048)).toBeNull();
    expect(previewOf('Makefile', 2048)).toBeNull();
    expect(previewOf('big.csv', PREVIEW_BYTES_MAX + 1)).toBeNull();
  });
});

describe('what a preview draws', () => {
  test('a CSV’s first fifty rows as a table, and how many more the file has', () => {
    const rows = Array.from({ length: 80 }, (_, n) => `${String(n)},row ${String(n)}`).join('\n');
    const drawn = previewMarkdown({ kind: 'table' }, `id,name\n${rows}`);
    expect(drawn.markdown.split('\n')).toHaveLength(52);
    expect(drawn.more).toEqual({ rows: 30 });
  });

  test('a CSV that is not a table after all is shown as written', () => {
    expect(previewMarkdown({ kind: 'table' }, 'just one line').markdown).toBe(
      '```\njust one line\n```',
    );
  });

  test('a long text is cut at a line, and says the file goes on', () => {
    const long = `${'x'.repeat(100)}\n`.repeat(1000);
    const drawn = previewMarkdown({ kind: 'markdown' }, long);
    expect(drawn.markdown.length).toBeLessThanOrEqual(64_000);
    expect(drawn.markdown.endsWith('x')).toBe(true);
    expect(drawn.more).toEqual({ cut: true });
  });

  test('code is a block in its language', () => {
    expect(previewMarkdown({ kind: 'code', language: 'ts' }, 'const a = 1;').markdown).toBe(
      '```ts\nconst a = 1;\n```',
    );
  });
});

describe('the preview in a message', () => {
  const visit = async (
    attachment: Attachment,
    read: (id: string) => Promise<string>,
  ): ReturnType<typeof renderApp> => {
    const view = await renderApp(
      <MessageRow
        message={aMessage(1, { attachments: [attachment] })}
        meId={ME.id}
        nowMinute={Date.UTC(2026, 8, 9, 12)}
        members={new Map([[ME.id, 'dogancan']])}
      />,
      { api: aSignedInApi({ attachmentText: read }) },
    );
    await settle();
    return view;
  };

  test('is read only when asked, drawn as a table, named, and hidden again', async () => {
    const asked: string[] = [];
    const csv = file('Satışlar.csv');
    const view = await visit(csv, (id) => {
      asked.push(id);
      return Promise.resolve('Bölge,Adet\nİstanbul,12\nAnkara,7');
    });
    // Nothing is read until the person asks: a feed of files is not a feed of downloads.
    expect(asked).toEqual([]);
    const toggle = view.getByRole('button', { name: 'Preview Satışlar.csv' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await person().click(toggle);
    await settle();
    expect(asked).toEqual([csv.id]);
    const region = view.getByRole('region', { name: 'Preview of Satışlar.csv' });
    const table = within(region).getByRole('table');
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((cell) => cell.textContent),
    ).toEqual(['Bölge', 'Adet']);
    expect(within(table).getByRole('cell', { name: 'İstanbul' })).toBeDefined();
    await expectNoAxeViolations(region);
    await person().click(view.getByRole('button', { name: 'Hide the preview of Satışlar.csv' }));
    expect(view.queryByRole('region', { name: 'Preview of Satışlar.csv' })).toBeNull();
    // Shown again, it is not asked for again: an attachment never changes.
    await person().click(view.getByRole('button', { name: 'Preview Satışlar.csv' }));
    await settle();
    expect(asked).toEqual([csv.id]);
  });

  test('a file that cannot be read says so, and Retry asks again', async () => {
    let calls = 0;
    const view = await visit(file('notes.md'), () => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error('offline')) : Promise.resolve('# Notes');
    });
    await person().click(view.getByRole('button', { name: 'Preview notes.md' }));
    await settle();
    const region = view.getByRole('region', { name: 'Preview of notes.md' });
    expect(within(region).getByText('The file could not be read.')).toBeDefined();
    await person().click(within(region).getByRole('button', { name: 'Retry' }));
    await settle();
    // A heading in a message is drawn as one, not made a page heading (`render-content.tsx`).
    expect(within(region).getByText('Notes').className).toContain('font-semibold');
  });

  test('a file it cannot read in place has no Preview', async () => {
    const view = await visit(file('report.pdf'), () => Promise.reject(new Error('not asked')));
    expect(view.queryByRole('button', { name: /Preview/ })).toBeNull();
  });
});
