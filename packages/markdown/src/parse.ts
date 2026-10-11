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
import { delimitersOutside, MARKDOWN_DELIMITERS_MAX, nestsTooDeep } from './scan';
import type { Align, Block, Inline, ListItem, MessageTree, TableRow } from './tree';

/** Nesting, on the tree, beyond which a body is shown as typed: what the line scan cannot see, like emphasis inside emphasis. */
export const MARKDOWN_DEPTH_MAX = 100;

/** The only addresses a link may go to; anything else — relative, `//host`, `javascript:` — is its label's text. */
const SAFE_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:', 'mailto:']);

const isSafeUrl = (url: string): boolean =>
  URL.canParse(url) && SAFE_PROTOCOLS.has(new URL(url).protocol);

export type Reading =
  | { readonly tree: MessageTree }
  | { readonly tree: null; readonly reason: 'nesting' | 'delimiters' | 'depth' | 'engine' };

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
  return start === undefined || end === undefined ? '' : text.slice(start, end);
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
          if (isSafeUrl(node.url)) out.push({ type: 'link', url: node.url, children });
          else out.push(...children);
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
          const ordered = node.ordered === true;
          const children = node.children.map((item): ListItem => ({
            type: 'listItem',
            checked: item.checked ?? null,
            children: blocks(item.children, depth + 2),
          }));
          out.push({ type: 'list', ordered, start: ordered ? (node.start ?? 1) : null, children });
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

/** A body's tree, or why it is shown as typed. Never throws. */
export const readMarkdown = (text: string): Reading => {
  if (nestsTooDeep(text)) return { tree: null, reason: 'nesting' };
  let root: Root;
  try {
    if (delimitersOutside(text, codeRangesOf(blockTreeOf(text))) > MARKDOWN_DELIMITERS_MAX) {
      return { tree: null, reason: 'delimiters' };
    }
    root = syntaxTreeOf(text);
  } catch {
    // The bounds exist so this is unreachable; the server logs it as a gap in them (D-101).
    return { tree: null, reason: 'engine' };
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
