/**
 * What a paste becomes (D-210): pure answers, from the clipboard's words to the markdown the box gets.
 * The box stays a plain textarea of markdown (D-110, D-181) — nothing here is an editor; each answer is
 * markdown the renderer already draws, put where the caret is, and the composer offers the paste as it
 * was in one step.
 *
 * - **A table**: rows a spreadsheet copied (tab-separated) or a CSV — a GFM table.
 * - **Formatted text**: what a document or a page copied (`text/html`) — its emphasis, links, lists,
 *   headings, quotes, code and tables in markdown, and nothing else of it.
 * - **Code**: a long paste becomes a fenced block (`asCodeBlock`); here, the language it is in, so it
 *   is coloured, and a diff is drawn as one (D-133).
 */
import { asCodeBlock, isCodeBlock, isLongPaste } from './composer-text';

/** At most this much HTML is read: a paste of a whole page is taken as its plain words instead. */
const HTML_MAX = 200_000;

/** A table needs at least a header and one row, of at least two columns. */
const TABLE_MIN_ROWS = 2;
const TABLE_MIN_COLUMNS = 2;
/** More rows than this is data for a file, not a message: left as it was pasted. */
const TABLE_MAX_ROWS = 200;

/**
 * Splits delimited text into rows of cells, RFC 4180's way: a cell in double quotes may hold the
 * delimiter, a line break, and a doubled quote for one.
 */
const parseDelimited = (text: string, delimiter: string): string[][] => {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let at = 0; at < text.length; at++) {
    const char = text.charAt(at);
    if (quoted) {
      if (char === '"' && text.charAt(at + 1) === '"') {
        cell += '"';
        at++;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"' && cell === '') {
      quoted = true;
    } else if (char === delimiter) {
      row.push(cell);
      cell = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text.charAt(at + 1) === '\n') at++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
};

/** A cell's words in a table: one line, and its pipes escaped so they are not columns. */
const asCell = (cell: string): string =>
  cell
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .trim();

/**
 * The rows of delimited text — a spreadsheet's copy (tabs) or a CSV (commas, or semicolons where the
 * comma is the decimal mark) — or `null` when it is not a table: every row with the same number of
 * columns, at least two of them, at least a header and a row.
 */
const rowsOf = (delimited: string): string[][] | null => {
  const text = delimited.replace(/(\r?\n)+$/, '');
  if (!text.includes('\n')) return null;
  for (const delimiter of ['\t', ',', ';']) {
    // A delimiter that is not on the first line is not this text's.
    if (!text.split('\n', 1)[0]?.includes(delimiter)) continue;
    const rows = parseDelimited(text, delimiter);
    const width = rows[0]?.length ?? 0;
    if (
      rows.length < TABLE_MIN_ROWS ||
      width < TABLE_MIN_COLUMNS ||
      rows.some((row) => row.length !== width)
    ) {
      continue;
    }
    // Prose with commas is not a table: comma-separated text needs short cells, as data has.
    if (delimiter !== '\t' && rows.some((row) => row.some((cell) => cell.length > 80))) continue;
    return rows;
  }
  return null;
};

/** Rows as a GFM table, the first its header. */
const tableOf = (rows: readonly (readonly string[])[]): string => {
  const line = (cells: readonly string[]): string =>
    `| ${cells.map((cell) => asCell(cell) || ' ').join(' | ')} |`;
  const [header = [], ...body] = rows;
  return [line(header), `| ${header.map(() => '---').join(' | ')} |`, ...body.map(line)].join('\n');
};

/** The paste as a GFM table, or `null` when it is not one, or is more rows than a message carries. */
export const tableFromDelimited = (pasted: string): string | null => {
  const rows = rowsOf(pasted);
  return rows === null || rows.length > TABLE_MAX_ROWS ? null : tableOf(rows);
};

/**
 * The language a pasted block is in, by what only that language looks like, or `null` when it is
 * not clear — an unnamed block is drawn plain, which is better than coloured wrong. Every name is one
 * the highlighter has a grammar for (`highlight.ts`).
 */
export const languageOf = (code: string): string | null => {
  const text = code.trim();
  if (text === '') return null;
  if (/^[[{]/.test(text)) {
    try {
      JSON.parse(text);
      return 'json';
    } catch {
      // Not JSON after all; something else that starts with a brace.
    }
  }
  if (/^(diff --git |--- \S.*\n\+\+\+ \S|@@ -\d)/m.test(text)) return 'diff';
  if (/^#!.*\b(ba|z)?sh\b/.test(text) || /^\$ \S/m.test(text)) return 'bash';
  if (/^<!doctype html|^<html[\s>]/i.test(text)) return 'html';
  if (
    /^\s*(select|insert into|update|delete from|create (table|index|view)|alter table|with \w+ as \()\b/im.test(
      text,
    ) &&
    /\b(from|where|values|set|on)\b/i.test(text)
  ) {
    return 'sql';
  }
  if (/^package \w+$/m.test(text) || (/^func \w*\(/m.test(text) && text.includes(':=')))
    return 'go';
  if (/\bfn \w+\s*[(<]/.test(text) && /(\blet mut\b|->|::|\bimpl\b)/.test(text)) return 'rust';
  if (
    /^(def \w+\(.*\):|class \w+(\(.*\))?:|from [\w.]+ import |import \w+$)/m.test(text) &&
    !/[{};]\s*$/m.test(text)
  ) {
    return 'python';
  }
  const typed =
    /^\s*(export\s+)?(interface|type|enum)\s+\w+/m.test(text) ||
    /\w\s*:\s*(string|number|boolean|unknown|void)\b/.test(text) ||
    /\bas const\b|\breadonly \w+/.test(text);
  const scripted = /\b(const|let|function|return|import|export)\b|=>/.test(text);
  const tags = /<[A-Z]\w*[\s/>]|<\/\w+>/.test(text);
  if (typed) return tags ? 'tsx' : 'ts';
  if (scripted && /[;{}()]/.test(text)) return tags ? 'tsx' : 'js';
  if (/^\s*<\w+[^>]*>[\s\S]*<\/\w+>\s*$/.test(text)) return 'html';
  if (/^[^{}\n]*[.#]?[\w-]+[^{}\n]*\{[^}]*:[^}]*;[^}]*\}/m.test(text)) return 'css';
  const lines = text
    .split('\n')
    .filter((line) => line.trim() !== '' && !line.trim().startsWith('#'));
  if (
    lines.length >= 2 &&
    lines.every((line) => /^\s*(- )?[\w.-]+:(\s|$)|^\s*- \S/.test(line)) &&
    !/[{};]/.test(text)
  ) {
    return 'yaml';
  }
  return null;
};

// ── HTML → markdown ─────────────────────────────────────────────────────────────────────────────

/** Characters that would be markdown if left as they are in a paragraph. */
const escapeText = (text: string): string => text.replace(/([\\`*_[\]~])/g, '\\$1');

/** A code span's fence: one backtick more than the longest run inside, as `insertMarkdown` does. */
const inlineCode = (code: string): string => {
  const longest = Math.max(0, ...(code.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longest + 1);
  return longest === 0 ? `${fence}${code}${fence}` : `${fence} ${code} ${fence}`;
};

const styleOf = (element: Element): string =>
  (element.getAttribute('style') ?? '').toLowerCase().replace(/\s+/g, '');

const isBold = (element: Element): boolean => {
  const style = styleOf(element);
  // Google Docs wraps the whole paste in `<b style="font-weight:normal">`: not bold.
  if (/font-weight:(normal|[1-5]00)\b/.test(style)) return false;
  return ['B', 'STRONG'].includes(element.tagName) || /font-weight:(bold|[6-9]00)\b/.test(style);
};

const isItalic = (element: Element): boolean =>
  ['I', 'EM'].includes(element.tagName) || styleOf(element).includes('font-style:italic');

const isStruck = (element: Element): boolean =>
  ['S', 'DEL', 'STRIKE'].includes(element.tagName) ||
  /text-decoration:[^;]*line-through/.test(styleOf(element));

/** Only addresses the renderer would link (`SafeHref`): the web and mail. */
const safeHref = (href: string | null): string | null =>
  href !== null && /^(https?:|mailto:)/i.test(href.trim()) ? href.trim() : null;

const BLOCKS = new Set([
  'P',
  'DIV',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'UL',
  'OL',
  'LI',
  'PRE',
  'BLOCKQUOTE',
  'TABLE',
  'HR',
  'SECTION',
  'ARTICLE',
  'HEADER',
  'FOOTER',
]);

/** One node's inline markdown: words, emphasis, links, code spans, breaks. */
const inlineNode = (node: Node): string => {
  if (node.nodeType === Node.TEXT_NODE) {
    return escapeText((node.textContent ?? '').replace(/\s+/g, ' '));
  }
  if (!(node instanceof Element)) return '';
  const tag = node.tagName;
  if (tag === 'BR') return '\\\n';
  // Images are not drawn in a message (D-101): what the picture was is kept, in words.
  if (tag === 'IMG') return escapeText(node.getAttribute('alt') ?? '');
  if (tag === 'CODE' || tag === 'KBD' || tag === 'SAMP') return inlineCode(node.textContent);
  if (BLOCKS.has(tag)) return ` ${inline(node)} `;
  const words = inline(node);
  const bare = words.trim();
  if (bare === '') return words;
  // Markers hug the words; the spaces around them stay outside, or they would not be markers.
  const lead = words.slice(0, words.length - words.trimStart().length);
  const tail = words.slice(words.trimEnd().length);
  let marked = bare;
  if (isStruck(node)) marked = `~~${marked}~~`;
  if (isItalic(node)) marked = `_${marked}_`;
  if (isBold(node)) marked = `**${marked}**`;
  const href = tag === 'A' ? safeHref(node.getAttribute('href')) : null;
  if (href !== null) marked = `[${marked}](${href})`;
  return lead + marked + tail;
};

/** The inline markdown of an element's children. */
const inline = (node: Node): string => Array.from(node.childNodes).map(inlineNode).join('');

/** A list's markdown, its items' own lists indented under them. */
const list = (element: Element, depth: number): string => {
  const ordered = element.tagName === 'OL';
  const items = Array.from(element.children).filter((child) => child.tagName === 'LI');
  return items
    .map((item, index) => {
      const marker = ordered ? `${String(index + 1)}. ` : '- ';
      const pad = ' '.repeat(depth * (ordered ? 3 : 2));
      const nested = Array.from(item.children)
        .filter((child) => child.tagName === 'UL' || child.tagName === 'OL')
        .map((child) => list(child, depth + 1));
      const own = item.cloneNode(true) as Element;
      for (const child of Array.from(own.children)) {
        if (child.tagName === 'UL' || child.tagName === 'OL') child.remove();
      }
      return [`${pad}${marker}${inline(own).trim()}`, ...nested].join('\n');
    })
    .join('\n');
};

const table = (element: Element): string | null => {
  const rows = Array.from(element.querySelectorAll('tr')).map((row) =>
    Array.from(row.children)
      .filter((cell) => cell.tagName === 'TD' || cell.tagName === 'TH')
      .map((cell) => inline(cell).replace(/\\\n/g, ' ').replace(/\|/g, '\\|').trim()),
  );
  const width = Math.max(0, ...rows.map((row) => row.length));
  if (rows.length < TABLE_MIN_ROWS || width < TABLE_MIN_COLUMNS) return null;
  const line = (cells: readonly string[]): string =>
    `| ${Array.from({ length: width }, (_, at) => cells[at] ?? '')
      .map((cell) => (cell === '' ? ' ' : cell))
      .join(' | ')} |`;
  const [header = [], ...body] = rows;
  return [
    line(header),
    `| ${Array.from({ length: width }, () => '---').join(' | ')} |`,
    ...body.map(line),
  ].join('\n');
};

/** The blocks of an element's children, each its own paragraph of markdown. */
const blocks = (node: Node): string[] => {
  const out: string[] = [];
  let run = '';
  const flush = (): void => {
    const words = run.replace(/[ \t]+/g, ' ').trim();
    if (words !== '') out.push(words);
    run = '';
  };
  for (const child of Array.from(node.childNodes)) {
    if (!(child instanceof Element) || !BLOCKS.has(child.tagName)) {
      run += inlineNode(child);
      continue;
    }
    flush();
    const tag = child.tagName;
    if (/^H[1-6]$/.test(tag)) {
      // The renderer draws three levels (D-101); deeper ones are the third.
      const level = Math.min(3, Number(tag.slice(1)));
      out.push(`${'#'.repeat(level)} ${inline(child).trim()}`);
    } else if (tag === 'UL' || tag === 'OL') {
      out.push(list(child, 0));
    } else if (tag === 'PRE') {
      const code = child.textContent.replace(/\n+$/, '');
      const named = /language-([\w+-]+)/.exec(child.querySelector('code')?.className ?? '')?.[1];
      const longest = Math.max(2, ...(code.match(/^`+/gm) ?? []).map((run) => run.length));
      const fence = '`'.repeat(longest + 1);
      out.push(`${fence}${named ?? languageOf(code) ?? ''}\n${code}\n${fence}`);
    } else if (tag === 'BLOCKQUOTE') {
      out.push(
        blocks(child)
          .join('\n\n')
          .split('\n')
          .map((line) => (line === '' ? '>' : `> ${line}`))
          .join('\n'),
      );
    } else if (tag === 'TABLE') {
      const drawn = table(child);
      if (drawn !== null) out.push(drawn);
      else out.push(inline(child).trim());
    } else if (tag === 'HR') {
      out.push('---');
    } else {
      out.push(...blocks(child));
    }
  }
  flush();
  return out.filter((block) => block !== '');
};

/** Structure markdown keeps; emphasis is found by `isBold`, `isItalic` and `isStruck`, by tag or by style. */
const STRUCTURE = 'a[href],ul,ol,h1,h2,h3,h4,h5,h6,blockquote,pre,code,table';

/**
 * Formatted text — from a document, a page, a mail — as markdown, or `null` when there is nothing to
 * keep (an editor's coloured code is plain words) or it is too large to read. Scripts and styles are
 * never run: the HTML is parsed into a document that is read, not shown.
 */
export const markdownFromHtml = (html: string): string | null => {
  if (html.length > HTML_MAX || typeof DOMParser === 'undefined') return null;
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  for (const gone of Array.from(parsed.querySelectorAll('script,style,template,head,meta,link'))) {
    gone.remove();
  }
  const body = parsed.body as HTMLElement | null;
  if (body === null) return null;
  // Whether there is anything markdown would keep; otherwise the plain words are the paste.
  const formatted =
    body.querySelector(STRUCTURE) !== null ||
    Array.from(body.querySelectorAll('*')).some(
      (element) => isBold(element) || isItalic(element) || isStruck(element),
    );
  if (!formatted) return null;
  const markdown = blocks(body).join('\n\n').trim();
  return markdown === '' ? null : markdown;
};

type PasteKind = 'table' | 'formatted' | 'code';

export interface ConvertedPaste {
  readonly kind: PasteKind;
  readonly markdown: string;
  /** Whether it goes on lines of its own (`placeBlock`), or in the line where the caret is. */
  readonly block: boolean;
}

/** Markdown that is a block where it starts: a heading, a quote, a list, a table, a fence. */
const BLOCK_START = /^(#{1,3} |> |- |\d+\. |\| |```)/;

/**
 * What a paste becomes, or `null` for the words as they were. Rows first — a spreadsheet's copy
 * carries its rows as HTML too, and a table is what was meant — then formatted text, then a long
 * paste as a block of code in its language, unless it already is one fenced block (D-205).
 */
export const convertPaste = (plain: string, html: string): ConvertedPaste | null => {
  const table = tableFromDelimited(plain);
  if (table !== null) return { kind: 'table', markdown: table, block: true };
  const formatted = html === '' ? null : markdownFromHtml(html);
  if (formatted !== null && formatted !== plain.trim()) {
    return {
      kind: 'formatted',
      markdown: formatted,
      block: formatted.includes('\n') || BLOCK_START.test(formatted),
    };
  }
  if (isLongPaste(plain) && !isCodeBlock(plain)) {
    return { kind: 'code', markdown: asCodeBlock(plain, languageOf(plain)), block: true };
  }
  return null;
};
