/**
 * A message body on screen: what is drawn for each thing the parser finds, what is never
 * drawn (markup from the text), and the code block's clamp, copy and colour.
 */
import { describe, expect, test } from 'bun:test';
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
  }: { ports?: ContentPorts; mentioned?: string[]; locale?: 'en' | 'tr' } = {},
): ReturnType<typeof renderApp> =>
  await renderApp(
    <ContentPortsContext.Provider value={ports}>
      <Toaster dismissLabel="Close" />
      {renderContent(content, mentioned === undefined ? {} : { mentioned: new Set(mentioned) })}
    </ContentPortsContext.Provider>,
    locale === undefined ? {} : { locale },
  );

describe('text', () => {
  test('keeps its line breaks and wraps inside the column', async () => {
    const view = await mount('one\ntwo');
    const paragraph = view.container.querySelector('p');
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
      expect(view.container.textContent).toBe(text);
    },
  );
});

describe('mentions', () => {
  test('a real one is highlighted, case-insensitively; one that names nobody stays plain', async () => {
    const view = await mount('hi @Alice and @ghost', { mentioned: ['alice'] });
    expect(view.getByText('@Alice').className).toContain('text-accent');
    expect(view.container.querySelectorAll('.text-accent')).toHaveLength(1);
    expect(view.container.textContent).toBe('hi @Alice and @ghost');
  });

  test('with nobody mentioned nothing is highlighted', async () => {
    const view = await mount('@alice');
    expect(view.container.querySelectorAll('.text-accent')).toHaveLength(0);
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
    const whole = await mount(`\`\`\`\n${twelve}\n\`\`\``);
    expect(whole.queryByRole('button', { name: /Show all/ })).toBeNull();
    expect(whole.container.querySelector('pre')?.className).not.toContain('max-h-code');
    whole.unmount();

    const view = await mount(`\`\`\`\n${fourteen}\n\`\`\``);
    const pre = view.container.querySelector('pre');
    expect(pre?.className).toContain('max-h-code');
    expect(pre?.getAttribute('tabindex')).toBeNull();
    const open = view.getByRole('button', { name: 'Show all 14 lines' });
    expect(open.getAttribute('aria-expanded')).toBe('false');
    await person().click(open);
    expect(view.container.querySelector('pre')?.className).not.toContain('max-h-code');
    expect(view.container.querySelector('pre')?.getAttribute('tabindex')).toBe('0');
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

  test('a clipboard the browser refuses is not an error the person has to read', async () => {
    const view = await mount('```\nx\n```', {
      ports: plainPorts({ copy: () => Promise.reject(new Error('denied')) }),
    });
    await person().click(view.getByRole('button', { name: 'Copy code' }));
    expect(view.queryByText('Copied')).toBeNull();
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
  test('a populated body passes the audit: links, code, a clamped block, a mention', async () => {
    const long = Array.from({ length: 20 }, (_, i) => `l${String(i)}`).join('\n');
    const view = await mount(`hi @bob https://example.test \`x\`\n\`\`\`ts\n${long}\n\`\`\``, {
      mentioned: ['bob'],
    });
    await expectNoAxeViolations(view.container);
  });
});
