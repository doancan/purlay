/**
 * What a message's markdown is read as: the constructs the product renders, and no others (D-101).
 *
 * This is a narrowed copy of the parser's tree, not the tree itself. Every kind the renderer
 * draws is listed here, and nothing reaches a renderer that is not: raw HTML, images, reference
 * definitions and footnotes are not parsed at all, and a link whose address is not one
 * `SAFE_PROTOCOLS` in `parse.ts` allows arrives as its label's text. The narrowing *is* the
 * sanitiser (`ARCHITECTURE.md` §8.1): one function, shared by the server and the client, so what
 * one accepts the other renders.
 */

export type Inline =
  | { readonly type: 'text'; readonly value: string }
  | { readonly type: 'inlineCode'; readonly value: string }
  | { readonly type: 'emphasis'; readonly children: readonly Inline[] }
  | { readonly type: 'strong'; readonly children: readonly Inline[] }
  | { readonly type: 'delete'; readonly children: readonly Inline[] }
  | { readonly type: 'link'; readonly url: string; readonly children: readonly Inline[] }
  | { readonly type: 'break' };

export interface ListItem {
  readonly type: 'listItem';
  /** A task list item's box; null for an ordinary item. */
  readonly checked: boolean | null;
  readonly children: readonly Block[];
}

export interface TableCell {
  readonly type: 'tableCell';
  readonly children: readonly Inline[];
}
export interface TableRow {
  readonly type: 'tableRow';
  readonly children: readonly TableCell[];
}
export type Align = 'left' | 'right' | 'center' | null;

export type Block =
  | { readonly type: 'paragraph'; readonly children: readonly Inline[] }
  /** Drawn at the body's size, bold: a heading in a conversation is emphasis, not a title (D-101). */
  | { readonly type: 'heading'; readonly children: readonly Inline[] }
  /** Only a fence makes one; `lang` is the info string's first word, or null. */
  | { readonly type: 'code'; readonly lang: string | null; readonly value: string }
  | { readonly type: 'blockquote'; readonly children: readonly Block[] }
  /** Numbered from `start`. */
  | {
      readonly type: 'list';
      readonly ordered: true;
      readonly start: number;
      readonly children: readonly ListItem[];
    }
  /** Bulleted: there is no number to start from. */
  | { readonly type: 'list'; readonly ordered: false; readonly children: readonly ListItem[] }
  | {
      readonly type: 'table';
      readonly align: readonly Align[];
      /** The first row is the header. */
      readonly children: readonly TableRow[];
    }
  | { readonly type: 'thematicBreak' };

export interface MessageTree {
  readonly type: 'root';
  readonly children: readonly Block[];
}
