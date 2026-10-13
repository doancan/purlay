/**
 * A message body on screen: what is drawn for each kind the narrowed tree holds (D-101), what is
 * never drawn (markup from the text, a link the check did not make), a body past the bounds, and
 * the code block's clamp, copy and colour.
 */
import { describe, expect, spyOn, test } from 'bun:test';
import { useState } from 'react';
import * as Markdown from '@purlay/markdown';
import {
  MARKDOWN_DELIMITERS_MAX,
  MARKDOWN_NESTING_MAX,
  MARKDOWN_RUN_MAX,
  parseMarkdown,
  proseNames,
  readMarkdown,
  type Engine,
  type MessageTree,
} from '@purlay/markdown';
import { MESSAGE_CONTENT_MAX } from '@purlay/types';
import type { Root } from 'mdast';
import { act, fireEvent } from '@testing-library/react';
import { expectNoAxeViolations } from '../../testing/axe';
import { installDom } from '../../testing/dom';
import { renderApp } from '../../testing/render';
import { Toaster } from '../../ui/toast';
import { person } from '../../testing/user';
import { ContentPortsContext, type ContentPorts } from './content-ports';
import type { HighlightToken } from './highlight';
import { CLAMP_ABOVE_LINES } from './code-block';
import { renderContent } from './render-content';
import { expectFocusOn } from '../../testing/focus';

installDom();

const plainPorts = (over: Partial<ContentPorts> = {}): ContentPorts => ({
  highlight: () => Promise.resolve(null),
  copy: () => Promise.resolve(),
  ...over,
});

const mount = async (
  content: string,
  {
    ports = plainPorts(),
    mentioned,
    locale,
    engine,
  }: { ports?: ContentPorts; mentioned?: string[]; locale?: 'en' | 'tr'; engine?: Engine } = {},
): ReturnType<typeof renderApp> =>
  await renderApp(
    <ContentPortsContext.Provider value={ports}>
      <Toaster dismissLabel="Close" />
      <aside>beside the body</aside>
      {renderContent(content, {
        ...(mentioned === undefined ? {} : { mentioned: new Set(mentioned) }),
        ...(engine === undefined ? {} : { engine }),
      })}
    </ContentPortsContext.Provider>,
    locale === undefined ? {} : { locale },
  );

/** The body's own box: what `renderContent` drew, and nothing the harness put beside it. */
const body = (view: { container: HTMLElement }): HTMLElement => {
  const box = view.container.querySelector<HTMLElement>('[data-message-body]');
  if (box === null) throw new Error('no message body was drawn');
  return box;
};

/** Whether the body was drawn as typed, and why: one paragraph holding exactly the characters sent. */
const asTyped = (view: { container: HTMLElement }, content: string, reason: string): boolean => {
  const box = body(view);
  return (
    box.children.length === 1 &&
    box.firstElementChild?.tagName === 'P' &&
    box.firstElementChild.getAttribute('data-as-typed') === reason &&
    box.textContent === content
  );
};

/**
 * Renders with the console captured and returns what was reported: the error a boundary caught
 * reaches the console through React, the only report the client has. Asserting on the error itself,
 * not merely that something was logged, so an unrelated warning cannot pass for it.
 */
const reportedWhile = async (draw: () => Promise<unknown>): Promise<string> => {
  const quiet = spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    await draw();
    return quiet.mock.calls
      .flat()
      .map((value) => (value instanceof Error ? value.message : String(value)))
      .join('\n');
  } finally {
    quiet.mockRestore();
  }
};

/** The highest a search for a bound may go before it is a failure, not a hang: the longest message. */
const SEARCH_CEILING = MESSAGE_CONTENT_MAX;

describe('text', () => {
  test('keeps its line breaks and wraps inside the column', async () => {
    const view = await mount('one\ntwo');
    const paragraph = body(view).querySelector('p');
    expect(paragraph?.textContent).toBe('one\ntwo');
    expect(paragraph?.className).toContain('whitespace-pre-wrap');
    expect(paragraph?.className).toContain('break-words');
  });

  test('is never read as markup: tags and script text are characters', async () => {
    const view = await mount('<img src=x onerror=alert(1)> <script>boom()</script>');
    expect(view.container.querySelector('img')).toBeNull();
    expect(view.container.querySelector('script')).toBeNull();
    expect(view.container.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  test('inline code is a code element', async () => {
    const view = await mount('run `bun test` now');
    expect(view.getByText('bun test').tagName).toBe('CODE');
  });
});

describe('links', () => {
  test('open in a new tab without handing the page over, and say so to a screen reader', async () => {
    const view = await mount('see https://example.test/a.');
    const link = view.getByRole('link');
    expect(link.getAttribute('href')).toBe('https://example.test/a');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(link.textContent).toContain('Opens in a new tab');
  });

  test.each(['javascript:alert(1)', 'data:text/html,x', 'ftp://example.test'])(
    '%s is text, not an anchor',
    async (text) => {
      const view = await mount(text);
      expect(view.queryByRole('link')).toBeNull();
      expect(body(view).textContent).toBe(text);
    },
  );

  test.each([
    '[x](javascript:alert(1))',
    '[x](JaVaScRiPt:alert(1))',
    '[x](data:text/html,y)',
    '[x](/relative)',
    '[x](//evil.example)',
    '[x][1]\n\n[1]: javascript:alert(1)',
  ])('written as markdown, %s is its label, not an anchor', async (text) => {
    const view = await mount(text);
    expect(view.queryByRole('link')).toBeNull();
    expect(body(view).querySelector('a')).toBeNull();
  });

  test('mailto is a link, with no host to name in its title', async () => {
    const view = await mount('[write](mailto:a@b.example)');
    const link = view.getByRole('link');
    expect(link.getAttribute('href')).toBe('mailto:a@b.example');
    expect(link.getAttribute('title')).toBeNull();
  });

  test('a bare address ends before the bracket around it, and inside a word is no address', async () => {
    const view = await mount('(https://x.example/a) and nothttps://y.example/b');
    const links = view.getAllByRole('link');
    expect(links.map((link) => link.getAttribute('href'))).toEqual(['https://x.example/a']);
    expect(body(view).textContent).toContain('nothttps://y.example/b');
  });

  test('a bare email address is a mailto link, and names nobody', async () => {
    const view = await mount('mail@host.test', { mentioned: ['host'] });
    expect(view.getByRole('link').getAttribute('href')).toBe('mailto:mail@host.test');
    expect(body(view).querySelectorAll('[data-mention]')).toHaveLength(0);
  });

  test('an image is a link to it, labelled with its alt text, and never an image (#110)', async () => {
    const view = await mount('![diagram](https://e.example/d.png)');
    expect(body(view).querySelector('img')).toBeNull();
    const link = view.getByRole('link');
    expect(link.getAttribute('href')).toBe('https://e.example/d.png');
    expect(link.textContent).toContain('diagram');
  });

  test('a link the check did not make is a defect: never an anchor, the body shown as typed, and reported', async () => {
    const forged = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [
            {
              type: 'link',
              url: { href: 'javascript:alert(1)' },
              children: [{ type: 'text', value: 'x' }],
            },
          ],
        },
      ],
    } as unknown as MessageTree;
    const read = spyOn(Markdown, 'readMarkdown').mockReturnValue({ tree: forged });
    try {
      let view: Awaited<ReturnType<typeof mount>> | undefined;
      const reported = await reportedWhile(async () => {
        view = await mount('anything');
      });
      if (view === undefined) throw new Error('not drawn');
      // The spy reached the renderer: without it there would be no forged link to refuse.
      expect(read).toHaveBeenCalled();
      expect(body(view).querySelector('a')).toBeNull();
      expect(asTyped(view, 'anything', 'failed')).toBe(true);
      expect(reported).toContain('a link whose address was not checked reached the renderer');
    } finally {
      read.mockRestore();
    }
  });
});

describe('markdown', () => {
  test('emphasis, strong and strikethrough are their elements', async () => {
    const view = await mount('*a* **b** ~~c~~');
    expect(view.getByText('a').tagName).toBe('EM');
    expect(view.getByText('b').tagName).toBe('STRONG');
    expect(view.getByText('c').tagName).toBe('DEL');
  });

  test('a heading is emphasis at the body size, not a title in the outline (D-101 §3)', async () => {
    const view = await mount('# Release\n\nnotes');
    expect(body(view).querySelector('h1, h2, h3, h4, h5, h6')).toBeNull();
    const heading = view.getByText('Release');
    expect(heading.tagName).toBe('P');
    expect(heading.className).toContain('font-semibold');
  });

  test('four spaces are indentation, not code (D-101 §4)', async () => {
    const view = await mount('    not code');
    expect(body(view).querySelector('pre, figure')).toBeNull();
    expect(body(view).textContent).toBe('not code');
  });

  test('a quotation is a blockquote', async () => {
    const view = await mount('> quoted');
    expect(body(view).querySelector('blockquote')?.textContent).toBe('quoted');
  });

  test('a quotation is a block with a quote glyph, not an edge — an edge is what a mention looked like', async () => {
    const view = await mount('> quoted');
    const quote = body(view).querySelector('blockquote');
    expect(quote?.className).not.toContain('border-l');
    expect(quote?.className).toContain('rounded-md');
    expect(quote?.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
  });

  test('a bulleted list, and a numbered one that keeps its first number', async () => {
    const view = await mount('- a\n- b\n\n3. c\n4. d');
    expect(body(view).querySelectorAll('ul > li')).toHaveLength(2);
    const numbered = body(view).querySelector('ol');
    expect(numbered?.getAttribute('start')).toBe('3');
    expect(numbered?.querySelectorAll('li')).toHaveLength(2);
  });

  test('a numbered task list keeps its numbers: the box sits inside a list item', async () => {
    const view = await mount('1. [x] one\n2. [ ] two');
    const items = [...body(view).querySelectorAll('ol > li')];
    expect(items).toHaveLength(2);
    // A flex item is not a list item, and has no number to show.
    expect(items.some((item) => item.className.includes('flex'))).toBe(false);
    expect(view.getAllByRole('img')).toHaveLength(2);
  });

  test('a task box says whether it is done, in the language of the page', async () => {
    const view = await mount('- [x] shipped\n- [ ] tested');
    expect(view.getByRole('img', { name: 'Done' })).toBeDefined();
    expect(view.getByRole('img', { name: 'Not done' })).toBeDefined();
    const turkish = await mount('- [x] shipped\n- [ ] tested', { locale: 'tr' });
    expect(turkish.getByRole('img', { name: 'Tamamlandı' })).toBeDefined();
    expect(turkish.getByRole('img', { name: 'Tamamlanmadı' })).toBeDefined();
  });

  test('a table has its header row, its alignment, and scrolls inside a box a keyboard can reach', async () => {
    const view = await mount('| a | b | c |\n|:-|:-:|-:|\n| 1 | 2 | 3 |');
    const headers = view.getAllByRole('columnheader');
    expect(headers.map((cell) => cell.textContent)).toEqual(['a', 'b', 'c']);
    expect(headers.every((cell) => cell.getAttribute('scope') === 'col')).toBe(true);
    const cells = view.getAllByRole('cell');
    const aligned = ['text-left', 'text-center', 'text-right'];
    expect(cells.map((cell, column) => cell.classList.contains(aligned[column] ?? ''))).toEqual([
      true,
      true,
      true,
    ]);
    const box = view.getByRole('group', { name: 'Table' });
    expect(box.getAttribute('tabindex')).toBe('0');
    expect(box.className).toContain('overflow-x-auto');
  });

  test('a table of only a header, and one whose rows are ragged, are drawn as written', async () => {
    const header = await mount('| a | b |\n|-|-|');
    expect(body(header).querySelectorAll('th')).toHaveLength(2);
    expect(body(header).querySelectorAll('td')).toHaveLength(0);
    const ragged = await mount('| a | b |\n|-|-|\n| 1 |\n| 1 | 2 | 3 |');
    expect([...body(ragged).querySelectorAll('tr')].map((row) => row.children.length)).toEqual([
      2, 1, 3,
    ]);
  });

  test('Tab reaches the table box, so a keyboard can scroll what overflows it', async () => {
    const view = await mount('| a | b |\n|-|-|\n| 1 | 2 |');
    await person().tab();
    expectFocusOn(view.getByRole('group', { name: 'Table' }));
  });

  test('an empty body draws an empty box, not a failure', async () => {
    const view = await mount('');
    expect(body(view).textContent).toBe('');
    expect(body(view).querySelector('[data-as-typed]')).toBeNull();
  });

  test('a thematic break is a rule, and a hard break is a line break', async () => {
    const view = await mount('a  \nb\n\n---\n\nc');
    expect(body(view).querySelector('hr')).not.toBeNull();
    expect(body(view).querySelector('br')).not.toBeNull();
  });

  test('a fence of tildes is code too, and its language is read in lower case', async () => {
    const view = await mount('~~~PY\nprint(1)\n~~~');
    expect(view.getByText('py')).toBeDefined();
    expect(body(view).querySelector('pre')?.textContent).toBe('print(1)');
  });

  test('raw HTML, as a block or inline, is the characters that were typed', async () => {
    const view = await mount('<script>\nboom()\n</script>\n\nx <b onclick=y>z</b>');
    expect(body(view).querySelector('script, b')).toBeNull();
    expect(body(view).textContent).toContain('<script>');
    expect(body(view).textContent).toContain('<b onclick=y>');
  });
});

describe('past a bound, the body is shown as typed (D-101 §5)', () => {
  test.each([
    ['delimiters', (n: number): string => `**b** ${'*'.repeat(n - 4)}`, MARKDOWN_DELIMITERS_MAX],
    ['nesting', (n: number): string => `${'> '.repeat(n)}**b**`, MARKDOWN_NESTING_MAX],
    ['run', (n: number): string => `**b** ${'a'.repeat(n)}`, MARKDOWN_RUN_MAX],
  ])('%s: formatted at the bound, as typed one past it', async (reason, make, bound) => {
    const at = await mount(make(bound));
    expect(body(at).querySelector('strong')).not.toBeNull();
    expect(body(at).querySelector('[data-as-typed]')).toBeNull();
    const past = make(bound + 1);
    expect(asTyped(await mount(past), past, reason)).toBe(true);
  });

  test('depth: formatted at the deepest tree the bound allows, as typed one level past it', async () => {
    const nested = (levels: number): string =>
      Array.from({ length: levels }, (_, level) => `${'  '.repeat(level)}- x`).join('\n');
    // The owner of the bound is `readMarkdown`; this finds where it falls rather than copying it,
    // and fails rather than hangs if the bound is ever gone.
    let levels = 1;
    while (readMarkdown(nested(levels)).tree !== null && levels < SEARCH_CEILING) levels += 1;
    expect(readMarkdown(nested(levels))).toEqual({ tree: null, reason: 'depth' });
    const deepest = await mount(nested(levels - 1));
    expect(body(deepest).querySelectorAll('ul').length).toBe(levels - 1);
    expect(asTyped(await mount(nested(levels)), nested(levels), 'depth')).toBe(true);
  });

  test('a body the engine fails on inside the bounds is shown as typed, and the cause is reported', async () => {
    const failing: Engine = {
      blocks: () => ({ type: 'root', children: [] }),
      full: () => {
        throw new RangeError('the engine ran out of stack');
      },
    };
    let view: Awaited<ReturnType<typeof mount>> | undefined;
    const reported = await reportedWhile(async () => {
      view = await mount('**b** and @alice', { engine: failing, mentioned: ['alice'] });
    });
    if (view === undefined) throw new Error('not drawn');
    expect(asTyped(view, '**b** and @alice', 'failed')).toBe(true);
    // As typed means as typed: no highlight either, since where code is is unknown.
    expect(body(view).querySelector('[data-mention]')).toBeNull();
    expect(reported).toContain('the engine ran out of stack');
  });

  test('a defect while drawing one body shows that body as typed, reports it, and leaves the page standing', async () => {
    // A node with no position makes the narrowing throw: a defect, not the engine's failure.
    const broken: Root = { type: 'root', children: [{ type: 'html', value: '<b>' }] };
    const defective: Engine = {
      blocks: () => ({ type: 'root', children: [] }),
      full: () => broken,
    };
    let view: Awaited<ReturnType<typeof mount>> | undefined;
    const reported = await reportedWhile(async () => {
      view = await mount('<b>', { engine: defective });
    });
    if (view === undefined) throw new Error('not drawn');
    expect(asTyped(view, '<b>', 'failed')).toBe(true);
    expect(view.getByText('beside the body')).toBeDefined();
    expect(reported).toContain('a html node has no position');
  });

  test('a body that failed is drawn afresh when it is edited', async () => {
    // Fails on one text and reads any other as a plain paragraph.
    const fussy: Engine = {
      blocks: () => ({ type: 'root', children: [] }),
      full: (text) => {
        if (text === 'first') throw new RangeError('the engine ran out of stack');
        return {
          type: 'root',
          children: [{ type: 'paragraph', children: [{ type: 'text', value: text }] }],
        };
      },
    };
    const Edited = (): React.JSX.Element => {
      const [content, setContent] = useState('first');
      return (
        <>
          <button
            type="button"
            onClick={() => {
              setContent('second');
            }}
          >
            edit
          </button>
          {renderContent(content, { engine: fussy })}
        </>
      );
    };
    let view: Awaited<ReturnType<typeof renderApp>> | undefined;
    await reportedWhile(async () => {
      view = await renderApp(<Edited />);
    });
    if (view === undefined) throw new Error('not drawn');
    expect(asTyped(view, 'first', 'failed')).toBe(true);
    await act(async () => {
      fireEvent.click(view?.getByRole('button', { name: 'edit' }) ?? document.body);
      await Promise.resolve();
    });
    expect(body(view).querySelector('[data-as-typed]')).toBeNull();
    expect(body(view).textContent).toBe('second');
  });

  test('the longest message, every word a real mention, is drawn whole', async () => {
    const words = Math.floor(MESSAGE_CONTENT_MAX / 3);
    const content = '@a '.repeat(words).trimEnd();
    const view = await mount(content, { mentioned: ['a'] });
    expect(body(view).querySelectorAll('[data-mention]')).toHaveLength(words);
  });
});

describe('mentions', () => {
  test('a real one is highlighted, case-insensitively; one that names nobody stays plain', async () => {
    const view = await mount('hi @Alice and @ghost', { mentioned: ['alice'] });
    expect(view.getByText('@Alice').className).toContain('text-accent-text');
    expect(view.container.querySelectorAll('[data-mention]')).toHaveLength(1);
    expect(body(view).textContent).toBe('hi @Alice and @ghost');
  });

  test('with nobody mentioned nothing is highlighted', async () => {
    const view = await mount('@alice');
    expect(view.container.querySelectorAll('[data-mention]')).toHaveLength(0);
  });

  test('inside emphasis and a list it is still prose, and highlighted', async () => {
    const view = await mount('**@alice**\n\n- @alice', { mentioned: ['alice'] });
    expect(body(view).querySelectorAll('[data-mention]')).toHaveLength(2);
  });

  test('inside code, inline or fenced, it is quoted, not addressed', async () => {
    const view = await mount('`@alice`\n\n~~~\n@alice\n~~~', { mentioned: ['alice'] });
    expect(body(view).querySelectorAll('[data-mention]')).toHaveLength(0);
  });

  test("the shape is the server's: after a letter outside ASCII it is part of a word", async () => {
    const view = await mount('é@alice', { mentioned: ['alice'] });
    expect(body(view).querySelectorAll('[data-mention]')).toHaveLength(0);
  });
});

describe('a code block', () => {
  const twelve = Array.from({ length: CLAMP_ABOVE_LINES }, (_, i) => `line ${String(i + 1)}`).join(
    '\n',
  );
  const fourteen = Array.from(
    { length: CLAMP_ABOVE_LINES + 2 },
    (_, i) => `line ${String(i + 1)}`,
  ).join('\n');

  test('has its language, its line count and its raw text', async () => {
    const view = await mount('```ts\nconst a = 1;\nconst b = 2;\n```');
    expect(view.getByText('ts')).toBeDefined();
    expect(view.getByText('2 lines')).toBeDefined();
    expect(view.container.querySelector('code')?.textContent).toBe('const a = 1;\nconst b = 2;');
  });

  test('with no language says it is text, and a single line is one line', async () => {
    const view = await mount('```\nx\n```');
    expect(view.getByText('text')).toBeDefined();
    expect(view.getByText('1 line')).toBeDefined();
  });

  test('an empty block has zero lines and nothing to copy but nothing', async () => {
    const view = await mount('```\n```');
    expect(view.getByText('0 lines')).toBeDefined();
  });

  test('twelve lines are shown whole; thirteen and over are clamped and open on request', async () => {
    // The fade says there is more below a clamp (`ARCHITECTURE.md` §8.2); it is drawing, not text.
    const fade = (view: { container: HTMLElement }): Element | null =>
      view.container.querySelector('[data-code-fade]');
    const whole = await mount(`\`\`\`\n${twelve}\n\`\`\``);
    expect(whole.queryByRole('button', { name: /Show all/ })).toBeNull();
    expect(whole.container.querySelector('pre')?.className).not.toContain('max-h-code');
    expect(fade(whole)).toBeNull();
    whole.unmount();

    const view = await mount(`\`\`\`\n${fourteen}\n\`\`\``);
    const pre = view.container.querySelector('pre');
    expect(pre?.className).toContain('max-h-code');
    expect(fade(view)?.getAttribute('aria-hidden')).toBe('true');
    expect(pre?.getAttribute('tabindex')).toBeNull();
    const open = view.getByRole('button', { name: 'Show all 14 lines' });
    expect(open.getAttribute('aria-expanded')).toBe('false');
    await person().click(open);
    expect(view.container.querySelector('pre')?.className).not.toContain('max-h-code');
    expect(view.container.querySelector('pre')?.getAttribute('tabindex')).toBe('0');
    expect(fade(view)).toBeNull();
    const close = view.getByRole('button', { name: 'Show fewer lines' });
    expect(close.getAttribute('aria-expanded')).toBe('true');
    await person().click(close);
    expect(view.container.querySelector('pre')?.className).toContain('max-h-code');
  });

  test('copies exactly what was written, even when the view is clamped, and says so', async () => {
    const copied: string[] = [];
    const view = await mount(`\`\`\`ts\n${fourteen}\n\`\`\``, {
      ports: plainPorts({
        copy: (text) => {
          copied.push(text);
          return Promise.resolve();
        },
      }),
    });
    await person().click(view.getByRole('button', { name: 'Copy code' }));
    expect(copied).toEqual([fourteen]);
    expect(view.getAllByText('Copied').length).toBeGreaterThan(0);
  });

  test('a clipboard the browser refuses is said, and the code is left to select by hand', async () => {
    const view = await mount('```\nx\n```', {
      ports: plainPorts({ copy: () => Promise.reject(new Error('denied')) }),
    });
    await person().click(view.getByRole('button', { name: 'Copy code' }));
    expect(view.queryByText('Copied')).toBeNull();
    expect(
      await view.findByText("Couldn't copy. Select the text and copy it yourself."),
    ).toBeDefined();
  });

  test('in Turkish, the same block speaks Turkish', async () => {
    const view = await mount('```go\nx\ny\n```', { locale: 'tr' });
    expect(view.getByText('2 satır')).toBeDefined();
    expect(view.getByRole('button', { name: 'Kodu kopyala' })).toBeDefined();
  });
});

describe('colour', () => {
  const tokens: readonly (readonly HighlightToken[])[] = [
    [
      { content: 'const', color: 'var(--shiki-token-keyword)', italic: false, bold: false },
      { content: ' a', color: null, italic: true, bold: false },
    ],
    [{ content: 'b', color: 'var(--shiki-token-string)', italic: false, bold: true }],
  ];

  test('arrives in place of the plain text without changing a character of it', async () => {
    let answer: (value: typeof tokens | null) => void = () => undefined;
    const pending = new Promise<typeof tokens | null>((resolve) => {
      answer = resolve;
    });
    const view = await mount('```ts\nconst a\nb\n```', {
      ports: plainPorts({ highlight: () => pending }),
    });
    const code = (): string => view.container.querySelector('code')?.textContent ?? '';
    expect(code()).toBe('const a\nb');
    expect(view.container.querySelector('code span')).toBeNull();
    await act(async () => {
      answer(tokens);
      await pending;
    });
    expect(code()).toBe('const a\nb');
    const painted = Array.from(view.container.querySelectorAll<HTMLElement>('code span span'));
    expect(painted.map((node) => node.style.color)).toEqual([
      'var(--shiki-token-keyword)',
      '',
      'var(--shiki-token-string)',
    ]);
    expect(view.container.querySelector('.italic')?.textContent).toBe(' a');
    expect(view.container.querySelector('.font-semibold')?.textContent).toBe('b');
  });

  test('a language it does not know, and a block with no language, stay plain and never ask', async () => {
    const asked: string[] = [];
    const ports = plainPorts({
      highlight: (_code, language) => {
        asked.push(language);
        return Promise.resolve(null);
      },
    });
    const none = await mount('```\nx\n```', { ports });
    expect(asked).toEqual([]);
    none.unmount();
    const unknown = await mount('```cobol\nx\n```', { ports });
    expect(asked).toEqual(['cobol']);
    expect(unknown.container.querySelector('code span')).toBeNull();
  });

  test('an answer that arrives after the block is gone is ignored', async () => {
    let answer: (value: typeof tokens | null) => void = () => undefined;
    const pending = new Promise<typeof tokens | null>((resolve) => {
      answer = resolve;
    });
    const view = await mount('```ts\nx\n```', { ports: plainPorts({ highlight: () => pending }) });
    view.unmount();
    await act(async () => {
      answer(tokens);
      await pending;
    });
    expect(view.container.querySelector('code span')).toBeNull();
  });
});

describe("the browser's own ports", () => {
  test('copy goes to the real clipboard', async () => {
    const written: string[] = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: (text: string): Promise<void> => {
          written.push(text);
          return Promise.resolve();
        },
      },
    });
    const view = await renderApp(renderContent('```\nraw text\n```'));
    // `fireEvent`, not `person()`: user-event installs a clipboard of its own over this one.
    fireEvent.click(view.getByRole('button', { name: 'Copy code' }));
    await act(() => Promise.resolve());
    expect(written).toEqual(['raw text']);
  });
});

describe('accessibility', () => {
  test('a populated body passes the audit: every kind the tree holds, a clamped block, a mention', async () => {
    const long = Array.from({ length: 20 }, (_, i) => `l${String(i)}`).join('\n');
    const view = await mount(
      [
        `# Title`,
        `hi @bob https://example.test \`x\` *a* **b** ~~c~~ [mail](mailto:a@b.example)`,
        `> quoted`,
        `- [x] done\n- [ ] open`,
        `1. one\n2. two`,
        `| a | b |\n|:-|-:|\n| 1 | 2 |`,
        `---`,
        `\`\`\`ts\n${long}\n\`\`\``,
      ].join('\n\n'),
      { mentioned: ['bob'] },
    );
    await expectNoAxeViolations(view.container);
  });

  test('in Turkish, and shown as typed, it passes the audit too', async () => {
    const view = await mount('- [x] bitti\n\n| a |\n|-|\n| 1 |', { locale: 'tr' });
    await expectNoAxeViolations(view.container);
    const past = `**b** ${'a'.repeat(MARKDOWN_RUN_MAX + 1)}`;
    const typed = await mount(past, { locale: 'tr' });
    expect(asTyped(typed, past, 'run')).toBe(true);
    await expectNoAxeViolations(typed.container);
  });

  test('clips what cannot wrap: a chain of joined emoji is one cluster and must not widen its row', async () => {
    const view = await mount(Array.from({ length: 300 }, () => '👩').join('\u200D'));
    expect(body(view).className).toContain('overflow-x-clip');
  });
});

describe('a link label cannot lie about where it goes', () => {
  const RLO = '\u202E';
  const PDF = '\u202C';

  test('bidirectional controls are stripped from the label and the label is isolated', async () => {
    const view = await mount(`[evil${RLO}moc.elpmaxe${PDF}](https://good.example/path)`);
    const link = view.getByRole('link');
    expect(link.textContent).not.toContain(RLO);
    expect(link.textContent).not.toContain(PDF);
    expect(link.querySelector('bdi')?.getAttribute('dir')).toBe('ltr');
    expect(link.getAttribute('href')).toBe('https://good.example/path');
  });

  test('the host it really goes to is in the title, in the language of the page', async () => {
    const view = await mount('[docs](https://good.example/path)');
    expect(view.getByRole('link').getAttribute('title')).toBe('Opens good.example');
  });

  test('formatting inside the label is stripped the same way', async () => {
    const view = await mount(
      `[**evil${RLO}moc.elpmaxe${PDF}** and _more${RLO}_](https://good.example/path)`,
    );
    const link = view.getByRole('link');
    expect(link.textContent).not.toContain(RLO);
    expect(link.textContent).not.toContain(PDF);
    expect(link.querySelector('strong')).not.toBeNull();
  });

  test('code inside the label, and the isolates as well as the overrides, are stripped', async () => {
    const LRI = '\u2066';
    const PDI = '\u2069';
    const view = await mount(`[\`a${RLO}b\` c${LRI}d${PDI}](https://good.example/path)`);
    const link = view.getByRole('link');
    for (const control of [RLO, LRI, PDI]) expect(link.textContent).not.toContain(control);
    expect(link.querySelector('code')?.textContent).toBe('ab');
  });

  test('outside a label the characters are the writer’s, and are kept', async () => {
    const view = await mount(`before ${RLO}after`);
    expect(body(view).textContent).toBe(`before ${RLO}after`);
  });

  test('in Turkish too', async () => {
    const view = await mount('[docs](https://good.example/path)', { locale: 'tr' });
    expect(view.getByRole('link').getAttribute('title')).toBe('good.example adresini açar');
  });
});

describe('what is highlighted is what notifies (#330)', () => {
  // Every body here names bob somewhere the old rules disagreed about; the server's names are the
  // shared reading's (`proseNames`), and the highlight must be exactly those, as many times.
  test.each([
    'hey @bob',
    '[@bob](https://example.com)',
    'https://medium.com/@bob',
    '`x`@bob',
    '`x`@bob and @bob',
    '[x](https://example.com)@bob',
    '`one\n\n@bob two`',
    '**@bob** and `@bob`',
    '> @bob\n\n- @bob',
  ])('%j', async (content) => {
    const tree = parseMarkdown(content);
    if (tree === null) throw new Error('not read');
    const notified = proseNames(tree).map((name) => name.toLowerCase());
    // The client is told who was really mentioned: here, everyone the text could name.
    const view = await mount(content, { mentioned: ['bob'] });
    const drawn = [...view.container.querySelectorAll('[data-message-body] [data-mention]')].map(
      (node) => node.textContent.slice(1).toLowerCase(),
    );
    expect(drawn).toEqual(notified);
    view.unmount();
  });
});
