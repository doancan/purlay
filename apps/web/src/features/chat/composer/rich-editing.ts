/** Selection-based editor operations shared by formatted editing and explicit source actions. */
import {
  AllSelection,
  EditorState,
  TextSelection,
  type Command,
  type Transaction,
} from 'prosemirror-state';
import { lift } from 'prosemirror-commands';
import { liftListItem } from 'prosemirror-schema-list';
import { closeHistory } from 'prosemirror-history';
import { richSchema, writeRichDocument } from './rich-document';
import { SafeHref } from '@purlay/markdown';
import type { Node as RichNode } from 'prosemirror-model';
import { emoticonEndingAt } from './emoticons';

const blankParagraph = (node: RichNode): boolean => {
  if (node.type !== richSchema.nodes.paragraph || node.textContent.trim() !== '') return false;
  let blank = true;
  node.forEach((child) => {
    if (
      (!child.isText && child.type !== richSchema.nodes.hard_break) ||
      child.marks.some(
        (mark) => mark.type === richSchema.marks.code || mark.type === richSchema.marks.link,
      )
    )
      blank = false;
  });
  return blank;
};

export const emptyRichDraft = (doc: RichNode): boolean => {
  let empty = true;
  doc.forEach((block) => {
    if (!blankParagraph(block)) empty = false;
  });
  return empty;
};

/** Drafts retain whitespace; sending keeps the existing trim-at-end contract. */
export const richMessageText = (state: EditorState, originalSource: string): string => {
  if (emptyRichDraft(state.doc)) return '';
  const tr = state.tr;
  while (tr.doc.childCount > 1 && tr.doc.lastChild !== null && blankParagraph(tr.doc.lastChild)) {
    tr.delete(tr.doc.content.size - tr.doc.lastChild.nodeSize, tr.doc.content.size);
  }
  let end = tr.doc.content.size - 1;
  while (end > 0 && !tr.doc.resolve(end).parent.isTextblock) end--;
  let position = tr.doc.resolve(end);
  if (position.parent.type === richSchema.nodes.paragraph) {
    let keep = position.parent.content.size;
    for (let index = position.parent.childCount - 1; index >= 0; index--) {
      const child = position.parent.child(index);
      if (child.type === richSchema.nodes.hard_break) {
        keep--;
        continue;
      }
      if (
        !child.isText ||
        child.marks.some(
          (mark) => mark.type === richSchema.marks.link || mark.type === richSchema.marks.code,
        )
      )
        break;
      const value = child.text ?? '';
      const trimmed = value.trimEnd();
      keep -= value.length - trimmed.length;
      if (trimmed !== '') break;
    }
    if (keep < position.parent.content.size) {
      tr.delete(position.start() + keep, position.end());
      position = tr.doc.resolve(position.start() + keep);
    }
  }
  const protectedTail =
    position.parent.type === richSchema.nodes.code_block ||
    position.nodeBefore?.marks.some(
      (mark) => mark.type === richSchema.marks.code || mark.type === richSchema.marks.link,
    ) === true;
  if (!protectedTail) {
    const before = position.parent.textBetween(0, position.parentOffset, '\n', '\n');
    const face = emoticonEndingAt(before, before.length);
    if (face !== null)
      tr.insertText(face.emoji, position.start() + face.start, position.start() + face.end);
  }
  return tr.docChanged ? writeRichDocument(tr.doc).text : originalSource;
};

export const writeLink =
  (label: string, address: string): Command =>
  (state, dispatch) => {
    const safe = SafeHref.of(address.trim());
    if (safe === null) return false;
    const { from, to } = state.selection;
    const caption = label.trim() === '' ? safe.href : label;
    const mark = richSchema.mark('link', { href: safe.href });
    const chosen = state.doc.textBetween(from, to, '\n');
    const tr =
      caption === chosen
        ? state.tr.addMark(from, to, mark)
        : state.tr.replaceSelectionWith(richSchema.text(caption, [mark]), false);
    dispatch?.(closeHistory(tr).scrollIntoView());
    return true;
  };

export interface EditorLink {
  readonly from: number;
  readonly to: number;
  readonly label: string;
  readonly address: string;
}

/** One complete contiguous link containing the caret or selection; never a partial mixed range. */
export const selectedLink = (state: EditorState): EditorLink | null => {
  const selection =
    state.selection instanceof AllSelection
      ? TextSelection.between(state.doc.resolve(0), state.doc.resolve(state.doc.content.size))
      : state.selection;
  const { $from, from, to } = selection;
  if (!$from.parent.inlineContent) return null;
  const links: EditorLink[] = [];
  $from.parent.forEach((child, offset) => {
    const mark = richSchema.marks.link.isInSet(child.marks);
    const start = $from.start() + offset;
    if (mark === undefined) return;
    const address: unknown = mark.attrs['href'];
    if (typeof address !== 'string') return;
    const run = links.at(-1);
    if (run?.address === address && run.to === start) {
      links[links.length - 1] = {
        ...run,
        to: start + child.nodeSize,
        label: run.label + child.textContent,
      };
    } else
      links.push({ from: start, to: start + child.nodeSize, address, label: child.textContent });
  });
  return links.find((link) => from >= link.from && to <= link.to) ?? null;
};

/** A selection is cleared; with only a caret the current paragraph is the explicit target. */
export const clearFormatting: Command = (state, dispatch) => {
  const original = state.selection;
  const selected =
    original instanceof AllSelection
      ? TextSelection.between(state.doc.resolve(0), state.doc.resolve(state.doc.content.size))
      : original;
  const from = selected.empty ? selected.$from.start() : selected.from;
  const to = selected.empty ? selected.$from.end() : selected.to;
  const tr = state.tr.setSelection(
    TextSelection.between(state.doc.resolve(from), state.doc.resolve(to)),
  );
  // setBlockType normalizes code newlines to spaces. Convert them explicitly to hard breaks first.
  const codeBlocks: { position: number; text: string }[] = [];
  tr.doc.nodesBetween(from, to, (child, position) => {
    if (child.type === richSchema.nodes.code_block)
      codeBlocks.push({ position, text: child.textContent });
  });
  for (const block of codeBlocks.reverse()) {
    tr.setNodeMarkup(block.position, richSchema.nodes.paragraph);
    for (let index = block.text.length - 1; index >= 0; index--) {
      if (block.text[index] === '\n')
        tr.replaceWith(
          block.position + 1 + index,
          block.position + 2 + index,
          richSchema.node('hard_break'),
        );
    }
  }
  tr.removeMark(from, to).setBlockType(from, to, richSchema.nodes.paragraph).setStoredMarks([]);
  // Lists need their item-aware lift; quotes use the ordinary lift. Collect the commands' steps
  // into one transaction so the entire clear action has a single undo boundary.
  for (;;) {
    const current = EditorState.create({ doc: tr.doc, selection: tr.selection });
    const append = (next: Transaction): void => {
      for (const step of next.steps) tr.step(step);
      tr.setSelection(
        TextSelection.between(
          tr.doc.resolve(next.selection.from),
          tr.doc.resolve(next.selection.to),
        ),
      );
    };
    if (liftListItem(richSchema.nodes.list_item)(current, append)) continue;
    if (!lift(current, append)) break;
  }
  if (original.empty)
    tr.setSelection(TextSelection.near(tr.doc.resolve(tr.mapping.map(original.from))));
  dispatch?.(closeHistory(tr).scrollIntoView());
  return true;
};

/** Keep the code intact and continue after it, reusing an existing following paragraph. */
export const leaveCode: Command = (state, dispatch) => {
  const selected =
    state.selection instanceof AllSelection
      ? TextSelection.between(state.doc.resolve(0), state.doc.resolve(state.doc.content.size))
      : state.selection;
  const { $from } = selected;
  if ($from.parent.type !== richSchema.nodes.code_block) return false;
  const after = $from.after();
  const tr = state.tr;
  if (tr.doc.nodeAt(after)?.type !== richSchema.nodes.paragraph)
    tr.insert(after, richSchema.node('paragraph'));
  tr.setSelection(TextSelection.create(tr.doc, after + 1)).setStoredMarks([]);
  dispatch?.(closeHistory(tr).scrollIntoView());
  return true;
};
