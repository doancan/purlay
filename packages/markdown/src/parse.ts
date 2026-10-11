/**
 * A message's markdown, read once into the tree the product renders (D-101, `ARCHITECTURE.md` §8.1).
 *
 * One engine on both sides — micromark, through `mdast-util-from-markdown`, the core `remark-parse`
 * wraps — so the server's metadata and the client's rendering come from the same reading of the
 * same characters. What the product does not render is not parsed at all (`engine.ts`): a construct
 * that is never recognised cannot be rendered wrongly.
 */
import type { Nodes, PhrasingContent, Root, RootContent } from 'mdast';
import { blockTreeOf, codeRangesOf, syntaxTreeOf } from './engine';
import { MARKDOWN_DELIMITERS_MAX, MARKDOWN_RUN_MAX, measureOutside, nestsTooDeep } from './scan';
import type { Align, Block, Inline, ListItem, MessageTree, TableRow } from './tree';

/** Nesting, on the tree, beyond which a body is shown as typed: what the line scan cannot see, like emphasis inside emphasis. */
export const MARKDOWN_DEPTH_MAX = 100;

/** The only addresses a link may go to; anything else — relative, `//host`, `javascript:` — is its label's text. */
const SAFE_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:', 'mailto:']);

/**
 * The address a link may carry, or null. What is returned is the URL as the browser will read it
 * (`href`), not the characters that were typed, so the string that was checked is the string that
 * is rendered.
 */
const safeHrefOf = (url: string): string | null => {
  if (!URL.canParse(url)) return null;
  const parsed = new URL(url);
  return SAFE_PROTOCOLS.has(parsed.protocol) ? parsed.href : null;
};

/** The engine's two readings, as arguments, so a failure inside the bounds can be injected and seen. */
export interface Engine {
  readonly blocks: (text: string) => Root;
  readonly full: (text: string) => Root;
}

const ENGINE: Engine = { blocks: blockTreeOf, full: syntaxTreeOf };

export type Reading =
  | { readonly tree: MessageTree }
  | { readonly tree: null; readonly reason: 'nesting' | 'delimiters' | 'run' | 'depth' }
  /** The engine threw inside the bounds: a gap in them, carried with its cause to be logged (D-101). */
  | { readonly tree: null; readonly reason: 'engine'; readonly error: unknown };

/** Thrown out of the narrowing when the tree is deeper than `MARKDOWN_DEPTH_MAX`; never escapes `readMarkdown`. */
class TooDeep extends Error {
  public constructor() {
    super(`the tree is deeper than ${String(MARKDOWN_DEPTH_MAX)}`);
  }
}

/** Adjacent text runs, joined: a link that became its label must not leave the sentence in pieces. */
const joined = (nodes: readonly Inline[]): Inline[] => {
  const out: Inline[] = [];
  for (const node of nodes) {
    const last = out.at(-1);
    if (node.type === 'text' && last?.type === 'text') {
      out[out.length - 1] = { type: 'text', value: last.value + node.value };
    } else out.push(node);
  }
  return out;
};

/** What a node the tree has no kind for is shown as: the characters it was written with. */
const sourceOf = (node: Nodes, text: string): string => {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  // The engine always records offsets; a node without them is a defect to see, not text to drop.
  if (start === undefined || end === undefined)
    throw new Error(`a ${node.type} node has no position`);
  return text.slice(start, end);
};

/**
 * The engine's tree, copied into the kinds the product draws. Exported so the second layer of the
 * sanitiser can be tested on nodes the engine is configured never to produce.
 */
export const narrowTree = (root: Root, text: string): MessageTree => {
  const guard = (depth: number): void => {
    if (depth > MARKDOWN_DEPTH_MAX) throw new TooDeep();
  };

  const inlines = (nodes: readonly PhrasingContent[], depth: number): Inline[] => {
    guard(depth);
    const out: Inline[] = [];
    for (const node of nodes) {
      switch (node.type) {
        case 'text':
          out.push({ type: 'text', value: node.value });
          break;
        case 'inlineCode':
          out.push({ type: 'inlineCode', value: node.value });
          break;
        case 'break':
          out.push({ type: 'break' });
          break;
        case 'emphasis':
        case 'strong':
        case 'delete':
          out.push({ type: node.type, children: inlines(node.children, depth + 1) });
          break;
        case 'link': {
          const children = inlines(node.children, depth + 1);
          const url = safeHrefOf(node.url);
          if (url === null) out.push(...children);
          else out.push({ type: 'link', url, children });
          break;
        }
        // Never recognised (`DISABLED`, and no footnotes): shown as the characters that were typed.
        case 'html':
        case 'image':
        case 'imageReference':
        case 'linkReference':
        case 'footnoteReference':
          out.push({ type: 'text', value: sourceOf(node, text) });
      }
    }
    return joined(out);
  };

  const blocks = (nodes: readonly RootContent[], depth: number): Block[] => {
    guard(depth);
    const out: Block[] = [];
    for (const node of nodes) {
      switch (node.type) {
        case 'paragraph':
          out.push({ type: 'paragraph', children: inlines(node.children, depth + 1) });
          break;
        case 'heading':
          out.push({ type: 'heading', children: inlines(node.children, depth + 1) });
          break;
        case 'code':
          out.push({ type: 'code', lang: node.lang ?? null, value: node.value });
          break;
        case 'blockquote':
          out.push({ type: 'blockquote', children: blocks(node.children, depth + 1) });
          break;
        case 'thematicBreak':
          out.push({ type: 'thematicBreak' });
          break;
        case 'list': {
          const children = node.children.map((item): ListItem => ({
            type: 'listItem',
            checked: item.checked ?? null,
            children: blocks(item.children, depth + 2),
          }));
          out.push(
            node.ordered === true
              ? { type: 'list', ordered: true, start: node.start ?? 1, children }
              : { type: 'list', ordered: false, children },
          );
          break;
        }
        case 'table': {
          const children = node.children.map((row): TableRow => ({
            type: 'tableRow',
            children: row.children.map((cell) => ({
              type: 'tableCell',
              children: inlines(cell.children, depth + 3),
            })),
          }));
          const align: Align[] = (node.align ?? []).map((value) => value ?? null);
          out.push({ type: 'table', align, children });
          break;
        }
        // Never recognised at this level (`DISABLED`, no footnotes, no front matter), or only
        // inside a parent handled above: shown as the characters that were typed.
        case 'html':
        case 'definition':
        case 'footnoteDefinition':
        case 'yaml':
        case 'listItem':
        case 'tableRow':
        case 'tableCell':
        case 'text':
        case 'inlineCode':
        case 'break':
        case 'emphasis':
        case 'strong':
        case 'delete':
        case 'link':
        case 'image':
        case 'imageReference':
        case 'linkReference':
        case 'footnoteReference':
          out.push({
            type: 'paragraph',
            children: [{ type: 'text', value: sourceOf(node, text) }],
          });
      }
    }
    return out;
  };

  return { type: 'root', children: blocks(root.children, 1) };
};

/**
 * A body's tree, or why it is shown as typed. The engine's own failures are caught and returned;
 * a defect in this package's code is not, and throws.
 */
export const readMarkdown = (text: string, engine: Engine = ENGINE): Reading => {
  if (nestsTooDeep(text)) return { tree: null, reason: 'nesting' };
  let blocks: Root;
  try {
    blocks = engine.blocks(text);
  } catch (error) {
    return { tree: null, reason: 'engine', error };
  }
  const prose = measureOutside(text, codeRangesOf(blocks));
  if (prose.delimiters > MARKDOWN_DELIMITERS_MAX) return { tree: null, reason: 'delimiters' };
  if (prose.longestRun > MARKDOWN_RUN_MAX) return { tree: null, reason: 'run' };
  let root: Root;
  try {
    root = engine.full(text);
  } catch (error) {
    return { tree: null, reason: 'engine', error };
  }
  try {
    return { tree: narrowTree(root, text) };
  } catch (error) {
    if (error instanceof TooDeep) return { tree: null, reason: 'depth' };
    throw error;
  }
};

/** A body's tree, or null when it is shown as typed. */
export const parseMarkdown = (text: string): MessageTree | null => readMarkdown(text).tree;

/**
 * The body with every fenced block the engine reads blanked to spaces, line breaks kept, so a
 * mention is looked for where the reader sees prose (D-12, D-101). The mention parser has rules for
 * code of its own, and they missed a `~~~` fence; asking the engine where code is closes that, and
 * any other case its rules and the renderer's would disagree on. A body whose block reading the
 * bounds forbid, or that the engine fails on, is returned as it is: the mention parser's own rules
 * still apply, and `readMarkdown` reports the failure.
 */
export const withoutFencedCode = (text: string, engine: Engine = ENGINE): string => {
  if (nestsTooDeep(text)) return text;
  let blocks: Root;
  try {
    blocks = engine.blocks(text);
  } catch {
    // Reported by `readMarkdown` on the same body, which the server runs beside this.
    return text;
  }
  let out = '';
  let from = 0;
  for (const range of codeRangesOf(blocks)) {
    out +=
      text.slice(from, range.start) + text.slice(range.start, range.end).replace(/[^\r\n]/g, ' ');
    from = range.end;
  }
  return out + text.slice(from);
};
