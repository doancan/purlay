/** The existing, bounded message grammar is also the formatted editor's import boundary. */
import { parseMarkdown, SafeHref, type Block, type Inline } from '@purlay/markdown';
import { Schema, type DOMOutputSpec, type Mark, type Node as RichNode } from 'prosemirror-model';
import { bulletList, orderedList, listItem } from 'prosemirror-schema-list';
import { tableNodes } from 'prosemirror-tables';
import { diffChars } from 'diff';
export const editorValue = <T>(value: T | null | undefined): T => {
  if (value === null || value === undefined)
    throw new Error('The editor document violated its schema');
  return value;
};
export const richSchema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: {
      content: 'inline*',
      group: 'block',
      parseDOM: [{ tag: 'p' }],
      toDOM: (): DOMOutputSpec => ['p', 0],
    },
    text: { group: 'inline' },
    empty_link: {
      inline: true,
      group: 'inline',
      atom: true,
      attrs: { href: {} },
      toDOM: (current): DOMOutputSpec => [
        'span',
        { contenteditable: 'false', 'data-empty-link': String(current.attrs['href']) },
        '\u200b',
      ],
      parseDOM: [
        {
          tag: 'span[data-empty-link]',
          getAttrs: (element): false | Record<string, unknown> => {
            const href = SafeHref.of(element.getAttribute('data-empty-link') ?? '');
            return href === null ? false : { href: href.href };
          },
        },
      ],
    },
    hard_break: {
      inline: true,
      group: 'inline',
      selectable: false,
      parseDOM: [{ tag: 'br' }],
      toDOM: (): DOMOutputSpec => ['br'],
    },
    heading: {
      attrs: { level: { default: 1 } },
      content: 'inline*',
      group: 'block',
      defining: true,
      parseDOM: [
        { tag: 'h1', attrs: { level: 1 } },
        { tag: 'h2', attrs: { level: 2 } },
        { tag: 'h3', attrs: { level: 3 } },
      ],
      toDOM: (node): DOMOutputSpec => [`h${String(node.attrs['level'])}`, 0],
    },
    blockquote: {
      content: 'block+',
      group: 'block',
      defining: true,
      parseDOM: [{ tag: 'blockquote' }],
      toDOM: (): DOMOutputSpec => ['blockquote', 0],
    },
    code_block: {
      content: 'text*',
      marks: '',
      group: 'block',
      code: true,
      defining: true,
      attrs: { language: { default: null } },
      parseDOM: [
        {
          tag: 'pre',
          preserveWhitespace: 'full',
          getAttrs: (element): Record<string, unknown> => {
            const language = element.getAttribute('data-language');
            return { language: language === '' ? null : language };
          },
        },
      ],
      toDOM: (current): DOMOutputSpec => [
        'pre',
        { 'data-language': String(current.attrs['language'] ?? '') },
        ['code', 0],
      ],
    },
    horizontal_rule: {
      group: 'block',
      parseDOM: [{ tag: 'hr' }],
      toDOM: (): DOMOutputSpec => ['hr'],
    },
    bullet_list: { ...bulletList, content: 'list_item+', group: 'block' },
    ordered_list: { ...orderedList, content: 'list_item+', group: 'block' },
    list_item: {
      ...listItem,
      content: 'paragraph block*',
      attrs: { checked: { default: null } },
      parseDOM: [
        {
          tag: 'li',
          contentElement: (element): HTMLElement =>
            element.querySelector<HTMLElement>(':scope > div') ?? element,
          getAttrs: (element): Record<string, unknown> => ({
            checked: element.hasAttribute('data-task')
              ? element.querySelector('[data-task-box]')?.getAttribute('aria-checked') === 'true'
              : null,
          }),
        },
      ],
      toDOM: (node): DOMOutputSpec =>
        node.attrs['checked'] === null
          ? ['li', 0]
          : [
              'li',
              { 'data-task': '' },
              [
                'span',
                {
                  contenteditable: 'false',
                  role: 'checkbox',
                  tabindex: '0',
                  'aria-checked': String(node.attrs['checked']),
                  'data-task-box': '',
                },
                node.attrs['checked'] ? '☑' : '☐',
              ],
              ['div', 0],
            ],
    },
    ...tableNodes({
      tableGroup: 'block',
      cellContent: 'paragraph',
      cellAttributes: {
        align: {
          default: null,
          setDOMAttr: (value, attrs): void => {
            if (value !== null)
              attrs['style'] = `text-align: ${typeof value === 'string' ? value : ''}`;
          },
        },
      },
    }),
  },
  marks: {
    strong: {
      parseDOM: [{ tag: 'strong' }, { tag: 'b' }],
      toDOM: (): DOMOutputSpec => ['strong', 0],
    },
    em: { parseDOM: [{ tag: 'em' }, { tag: 'i' }], toDOM: (): DOMOutputSpec => ['em', 0] },
    strike: { parseDOM: [{ tag: 's' }, { tag: 'del' }], toDOM: (): DOMOutputSpec => ['s', 0] },
    link: {
      attrs: { href: {} },
      inclusive: false,
      parseDOM: [
        {
          tag: 'a[href]',
          getAttrs: (element): false | Record<string, unknown> => {
            const href = SafeHref.of(element.getAttribute('href') ?? '');
            return href === null ? false : { href: href.href };
          },
        },
      ],
      toDOM: (mark): DOMOutputSpec => ['a', { href: String(mark.attrs['href']) }, 0],
    },
    code: { code: true, parseDOM: [{ tag: 'code' }], toDOM: (): DOMOutputSpec => ['code', 0] },
  },
});
const node = (
  name: string,
  children: readonly RichNode[] = [],
  attrs?: Record<string, unknown>,
): RichNode => richSchema.node(name, attrs, children);
const inlines = (items: readonly Inline[], marks: readonly Mark[] = []): RichNode[] =>
  items.flatMap((item): RichNode[] => {
    switch (item.type) {
      case 'text':
        return item.value === '' ? [] : [richSchema.text(item.value, marks)];
      case 'inlineCode':
        return item.value === ''
          ? []
          : [richSchema.text(item.value, [...marks, richSchema.mark('code')])];
      case 'break':
        return [node('hard_break')];
      case 'strong':
        return inlines(item.children, [...marks, richSchema.mark('strong')]);
      case 'emphasis':
        return inlines(item.children, [...marks, richSchema.mark('em')]);
      case 'delete':
        return inlines(item.children, [...marks, richSchema.mark('strike')]);
      case 'link':
        if (item.children.length === 0)
          return [node('empty_link', [], { href: item.url.href }).mark(marks)];
        return inlines(item.children, [...marks, richSchema.mark('link', { href: item.url.href })]);
    }
  });
const blocks = (items: readonly Block[]): RichNode[] =>
  items.map((item): RichNode => {
    switch (item.type) {
      case 'paragraph':
        return node('paragraph', inlines(item.children));
      case 'heading':
        return node('heading', inlines(item.children), { level: item.level });
      case 'code':
        return node('code_block', item.value === '' ? [] : [richSchema.text(item.value)], {
          language: item.lang,
        });
      case 'blockquote':
        return node(
          'blockquote',
          item.children.length === 0 ? [node('paragraph')] : blocks(item.children),
        );
      case 'thematicBreak':
        return node('horizontal_rule');
      case 'list':
        return node(
          item.ordered ? 'ordered_list' : 'bullet_list',
          item.children.map((child) => {
            const children = blocks(child.children);
            if (children[0]?.type.name !== 'paragraph') children.unshift(node('paragraph'));
            return node('list_item', children, { checked: child.checked });
          }),
          item.ordered ? { order: item.start } : undefined,
        );
      case 'table':
        return node(
          'table',
          item.children.map((row, rowAt) =>
            node(
              'table_row',
              row.children.map((cell, colAt) =>
                node(
                  rowAt === 0 ? 'table_header' : 'table_cell',
                  [node('paragraph', inlines(cell.children))],
                  { align: item.align[colAt] ?? null },
                ),
              ),
            ),
          ),
        );
    }
  });
export const readRichDocument = (text: string): RichNode => {
  const tree = parseMarkdown(text);
  const children =
    tree === null
      ? [node('paragraph', text === '' ? [] : [richSchema.text(text)])]
      : blocks(tree.children);
  return node('doc', children.length === 0 ? [node('paragraph')] : children);
};
export interface RichSource {
  readonly text: string;
  /** UTF-16 source offsets at every ProseMirror document position. */
  readonly positions: readonly number[];
  readonly edges: ReadonlyMap<
    number,
    readonly { readonly offset: number; readonly marks: readonly string[] }[]
  >;
}
/** Escaping literal punctuation prevents a later edit from accidentally creating new Markdown. */
const escape = (value: string): string => value.replace(/[\\`*_[\]<>~|]/g, '\\$&');
const destination = (value: string): string =>
  (SafeHref.of(value)?.href ?? '').replace(/[\\()<>\s]/gu, (character) =>
    character === '(' ? '%28' : character === ')' ? '%29' : encodeURIComponent(character),
  );
const ticks = (value: string, minimum: number): string => {
  let longest = minimum;
  for (const match of value.matchAll(/`+/g)) longest = Math.max(longest, match[0].length + 1);
  return '`'.repeat(longest);
};
/** Serialize the supported GFM nodes while retaining an exact caret map, including escapes. */
export const writeRichDocument = (doc: RichNode): RichSource => {
  let text = '';
  let prefix = '';
  const positions: number[] = Array.from({ length: doc.content.size + 1 }, () => NaN);
  const edges = new Map<number, { offset: number; marks: readonly string[] }[]>();
  const edge = (position: number, marks: readonly Mark[]): void => {
    const choices = edges.get(position) ?? [];
    choices.push({ offset: text.length, marks: marks.map((mark) => mark.type.name) });
    edges.set(position, choices);
  };
  const write = (value: string): void => {
    for (const char of value) {
      if (text.endsWith('\n')) text += prefix;
      text += char;
    }
  };
  const at = (position: number): void => {
    // A caret at the beginning of an indented line belongs after its Markdown prefix.
    if (text.endsWith('\n')) text += prefix;
    positions[position] = text.length;
  };
  const inline = (parent: RichNode, start: number, table = false): void => {
    let lineText = '';
    let protectedText = false;
    let opened: readonly Mark[] = [];
    const delimiters = new Map<string, readonly [string, string]>();
    const close = (from: number): void => {
      for (let i = opened.length - 1; i >= from; i--)
        write(delimiters.get(editorValue(opened[i]).type.name)?.[1] ?? '');
    };
    const tokens: {
      value: string;
      position: number;
      marks: readonly Mark[];
      literal: boolean;
      hardBreak: boolean;
      protect: boolean;
    }[] = [];
    parent.forEach((child, offset) => {
      const emptyLink = child.type.name === 'empty_link';
      const literal = emptyLink || child.marks.some((mark) => mark.type.name === 'code');
      const value = child.text ?? '';
      const protect =
        !literal &&
        !child.marks.some((mark) => mark.type.name === 'link') &&
        (/https?:\/\/|www\./i.test(value) || /[^\s@]@[^\s@]/u.test(value));
      if (!child.isText || literal)
        tokens.push({
          value: emptyLink
            ? `[](<${destination(String(child.attrs['href']))}>)`
            : (child.text ?? '  \n'),
          position: start + offset,
          marks: child.marks,
          literal,
          hardBreak: !child.isText,
          protect: false,
        });
      else
        for (let i = 0; i < editorValue(child.text).length; i++)
          tokens.push({
            value: editorValue(child.text).charAt(i),
            position: start + offset + i,
            marks: child.marks,
            literal: false,
            hardBreak: false,
            protect,
          });
    });
    // Delimiters cannot enclose boundary whitespace. A whitespace run keeps only marks shared by
    // the visible characters on both sides; stored marks still govern subsequent typing in the view.
    for (let i = 0; i < tokens.length; i++) {
      if (editorValue(tokens[i]).literal || !/^\s$/.test(editorValue(tokens[i]).value)) continue;
      const first = i;
      while (
        i + 1 < tokens.length &&
        !editorValue(tokens[i + 1]).literal &&
        /^\s$/.test(editorValue(tokens[i + 1]).value)
      )
        i++;
      const before = tokens[first - 1]?.marks ?? [];
      const after = tokens[i + 1]?.marks ?? [];
      const shared = before.filter((mark) => after.some((other) => mark.eq(other)));
      const boundary =
        first === 0 ||
        i === tokens.length - 1 ||
        tokens[first - 1]?.hardBreak === true ||
        tokens[i + 1]?.hardBreak === true ||
        tokens.slice(first, i + 1).some((token) => token.value === '\n');
      for (let at = first; at <= i; at++) {
        const token = editorValue(tokens[at]);
        token.marks = token.marks.filter(
          (mark) => mark.type.name === 'link' || shared.some((other) => other.eq(mark)),
        );
        if (
          boundary &&
          token.value !== '\n' &&
          !token.marks.some((mark) => mark.type.name === 'link')
        )
          token.protect = true;
      }
    }
    if (tokens[0]?.value === '  \n') write('[]()');
    for (const [tokenIndex, token] of tokens.entries()) {
      const endOfMark = (mark: Mark): number => {
        let end = tokenIndex;
        while (tokens[end]?.marks.some((other) => mark.eq(other)) === true) end++;
        return end;
      };
      const position = token.position;
      const ordered = [
        ...opened.filter((mark) => token.marks.some((other) => mark.eq(other))),
        ...token.marks
          .filter((mark) => !opened.some((other) => mark.eq(other)))
          .sort(
            (a, b) =>
              endOfMark(b) - endOfMark(a) ||
              Number(b.type.name === 'link') - Number(a.type.name === 'link'),
          ),
      ];
      // Code must be the innermost mark: Markdown delimiters inside backticks are literal text.
      // Reopen its fence whenever an intersecting emphasis/link mark changes.
      const code = ordered.find((mark) => mark.type.name === 'code');
      const marks = ordered.filter((mark) => mark.type.name !== 'code');
      if (code !== undefined) marks.push(code);
      let common = 0;
      while (
        common < opened.length &&
        common < marks.length &&
        editorValue(opened[common]).eq(editorValue(marks[common]))
      )
        common++;
      const changed = common !== opened.length || common !== marks.length;
      if (protectedText && (changed || !token.protect)) {
        write(']()');
        protectedText = false;
      }
      if (changed) edge(position, opened);
      close(common);
      if (changed) edge(position, opened.slice(0, common));
      for (let i = common; i < marks.length; i++) {
        const mark = editorValue(marks[i]);
        const delimiter: readonly [string, string] =
          mark.type.name === 'strong'
            ? ['**', '**']
            : mark.type.name === 'em'
              ? ((): readonly [string, string] => {
                  const before = tokens[tokenIndex - 1]?.value.at(-1) ?? '';
                  const after = tokens[endOfMark(mark)]?.value.charAt(0) ?? '';
                  const delimiter = /[\p{L}\p{N}]/u.test(before + after) ? '*' : '_';
                  return [delimiter, delimiter];
                })()
              : mark.type.name === 'strike'
                ? ['~~', '~~']
                : mark.type.name === 'link'
                  ? ['[', `](<${destination(String(mark.attrs['href']))}>)`]
                  : ((): readonly [string, string] => {
                      const fence = ticks(token.value, 1);
                      const pad =
                        /^`|`$/.test(token.value) ||
                        (/^ | $/.test(token.value) && /\S/.test(token.value))
                          ? ' '
                          : '';
                      return [fence + pad, pad + fence] as const;
                    })();
        delimiters.set(mark.type.name, delimiter);
        write(delimiter[0]);
      }
      opened = marks;
      // Empty destinations are rendered as their label by SafeHref. Unlike punctuation escapes,
      // they also suppress GFM's post-decoding autolink pass without altering visible URL text.
      if (token.protect && !protectedText) {
        write('[');
        protectedText = true;
      }
      if (changed) edge(position, marks);
      at(position);
      if (!token.hardBreak) {
        for (let i = 0; i < token.value.length; i++) {
          const char = token.value.charAt(i);
          let escaped = escape(char);
          if (
            char === '_' &&
            /[\p{L}\p{N}]/u.test(lineText.at(-1) ?? '') &&
            !marks.some((mark) => mark.type.name === 'em')
          )
            escaped = char;
          if (
            (/[#+-]/.test(char) && /^ {0,3}$/.test(lineText)) ||
            (/[.)]/.test(char) && /^ {0,3}\d+$/.test(lineText))
          )
            escaped = '\\' + char;
          write(token.literal ? (table && char === '|' ? '\\|' : char) : escaped);
          lineText = char === '\n' ? '' : lineText + char;
          at(position + i + 1);
        }
      } else {
        // A whitespace-only line would split the paragraph and drop an intentional empty line.
        write(
          token.value === '  \n' && tokens[tokenIndex - 1]?.value === '  \n' ? '\\\n' : token.value,
        );
        lineText = '';
        at(position + 1);
      }
    }
    const end = start + parent.content.size;
    if (protectedText) write(']()');
    if (opened.length > 0) edge(end, opened);
    close(0);
    if (tokens.at(-1)?.value === '  \n') write('[]()');
    if (opened.length > 0) {
      at(end);
      edge(end, []);
    }
    if (parent.childCount === 0) at(start);
  };
  const children = (parent: RichNode, start: number, gap: string): void => {
    let run = 0;
    let previous = '';
    parent.forEach((child, offset, index) => {
      if (index > 0) write(gap);
      run = child.type.name === previous ? run + 1 : 0;
      block(child, start + offset, run % 2 === 1);
      previous = child.type.name;
    });
  };
  const block = (current: RichNode, position: number, alternate = false): void => {
    at(position);
    switch (current.type.name) {
      case 'paragraph':
        inline(current, position + 1);
        break;
      case 'heading':
        write('#'.repeat(Number(current.attrs['level'])) + ' ');
        inline(current, position + 1);
        break;
      case 'code_block': {
        const fence = ticks(current.textContent, 3);
        write(`${fence}${String(current.attrs['language'] ?? '')}\n`);
        at(position + 1);
        for (let i = 0; i < current.textContent.length; i++) {
          write(current.textContent.charAt(i));
          at(position + i + 2);
        }
        write(`\n${fence}`);
        break;
      }
      case 'blockquote': {
        const previous = prefix;
        write('> ');
        prefix += '> ';
        children(current, position + 1, '\n\n');
        prefix = previous;
        break;
      }
      case 'bullet_list':
      case 'ordered_list': {
        current.forEach((item, offset, index) => {
          if (index > 0) write('\n');
          const marker =
            current.type.name === 'ordered_list'
              ? `${String(Number(current.attrs['order']) + index)}${alternate ? ')' : '.'} `
              : alternate
                ? '+ '
                : '- ';
          const previous = prefix;
          write(
            marker +
              (item.attrs['checked'] === null ? '' : item.attrs['checked'] ? '[x] ' : '[ ] '),
          );
          prefix += ' '.repeat(marker.length);
          at(position + 1 + offset);
          children(item, position + 2 + offset, '\n\n');
          at(position + offset + item.nodeSize);
          prefix = previous;
        });
        break;
      }
      case 'table': {
        current.forEach((row, offset, rowAt) => {
          if (rowAt > 0) write('\n');
          write('| ');
          at(position + 1 + offset);
          row.forEach((cell, cellOffset, colAt) => {
            if (colAt > 0) write(' | ');
            at(position + 2 + offset + cellOffset);
            inline(editorValue(cell.firstChild), position + 4 + offset + cellOffset, true);
            at(position + 2 + offset + cellOffset + cell.nodeSize - 1);
          });
          write(' |');
          if (rowAt === 0) {
            write('\n|');
            row.forEach((cell) => {
              const align: unknown = cell.attrs['align'];
              write(
                ` ${align === 'left' || align === 'center' ? ':' : ''}---${align === 'right' || align === 'center' ? ':' : ''} |`,
              );
            });
          }
        });
        break;
      }
      case 'horizontal_rule':
        write('---');
        break;
      default:
        throw new Error(`Unsupported editor block: ${current.type.name}`);
    }
    if (Number.isNaN(positions[position + current.nodeSize - 1]))
      at(position + current.nodeSize - 1);
  };
  children(doc, 0, '\n\n');
  positions[doc.content.size] = text.length;
  for (let index = 0; index < positions.length; index++) {
    if (!Number.isFinite(positions[index])) positions[index] = positions[index - 1] ?? 0;
  }
  return { text, positions, edges };
};
export const richPosition = (source: RichSource, offset: number): number => {
  let best = 1;
  let distance = Infinity;
  source.positions.forEach((value, position) => {
    const next = Math.abs(value - offset);
    if (next < distance) {
      best = position;
      distance = next;
    }
  });
  for (const [position, choices] of source.edges) {
    for (const choice of choices) {
      const next = Math.abs(choice.offset - offset);
      if (next < distance) {
        best = position;
        distance = next;
      }
    }
  }
  return best;
};
/** Viewing an existing draft must neither normalize it nor move selections to the wrong words. */
export const originalRichSource = (doc: RichNode, original: string): RichSource | null => {
  const written = writeRichDocument(doc);
  if (written.text === original) return written;
  const changes = diffChars(written.text, original, { timeout: 20, maxEditLength: 8192 });
  if (changes === undefined) return null;
  const offsets: number[] = [];
  let normalized = 0;
  let source = 0;
  for (const change of changes) {
    if (change.added) {
      source += change.value.length;
      offsets[normalized] = source;
    } else if (change.removed) {
      for (let remaining = change.value.length; remaining > 0; remaining--) {
        offsets[normalized++] = source;
      }
    } else {
      for (let remaining = change.value.length; remaining > 0; remaining--) {
        offsets[normalized++] = source++;
      }
    }
  }
  offsets[normalized] = source;
  return {
    text: original,
    positions: written.positions.map((offset) => offsets[offset] ?? original.length),
    edges: new Map(
      Array.from(written.edges, ([position, choices]) => [
        position,
        choices.map((choice) => ({ ...choice, offset: offsets[choice.offset] ?? original.length })),
      ]),
    ),
  };
};

/** Stored marks distinguish typing just inside a closing delimiter from typing just outside it. */
export const richOffset = (
  source: RichSource,
  position: number,
  marks: readonly Mark[],
): number => {
  const names = marks.map((mark) => mark.type.name);
  const choice = source.edges
    .get(position)
    ?.find(
      (candidate) =>
        candidate.marks.length === names.length &&
        names.every((name) => candidate.marks.includes(name)),
    );
  return choice?.offset ?? source.positions[position] ?? source.text.length;
};
