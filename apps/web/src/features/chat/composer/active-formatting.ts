/** A selection is active only when one parsed range contains all of it. */
import { formattingRanges, type FormattingRange, type MarkdownFormat } from '@purlay/markdown';
import type { Selection } from './composer-text';

const LISTS: ReadonlySet<MarkdownFormat> = new Set(['bullets', 'numbers', 'tasks']);
const EMPTY_MARKS = [
  ['bold', '**'],
  ['italic', '_'],
  ['strike', '~~'],
  ['inlineCode', '`'],
] as const;

export const activeFormatting = (
  text: string,
  ranges: readonly FormattingRange[] | null,
  selection: Selection,
): ReadonlySet<MarkdownFormat> => {
  const active = new Set<MarkdownFormat>();
  if (ranges === null) return active;
  const point = selection.start === selection.end;
  let listDepth = -1;
  for (const range of ranges) {
    const start = point ? range.contentStart : range.start;
    const end = point ? range.contentEnd : range.end;
    if (selection.start < start || selection.end > end) continue;
    if (LISTS.has(range.kind)) {
      if (range.depth < listDepth) continue;
      for (const kind of LISTS) active.delete(kind);
      listDepth = range.depth;
    }
    active.add(range.kind);
  }
  if (
    !point &&
    listDepth >= 0 &&
    ranges.some(
      (range) =>
        LISTS.has(range.kind) &&
        !active.has(range.kind) &&
        range.depth > listDepth &&
        range.start < selection.end &&
        range.end > selection.start,
    )
  ) {
    for (const kind of LISTS) active.delete(kind);
  }
  // A button may just have inserted empty markers. They are a writing position, not yet a
  // rendered emphasis node ("****" alone is a thematic break until something is typed).
  if (point) {
    const before = text.slice(0, selection.start);
    const after = text.slice(selection.end);
    const candidates = EMPTY_MARKS.filter(
      ([, mark]) => before.endsWith(mark) && after.startsWith(mark),
    );
    const emptyTask = before.endsWith('] ') && (after === '' || after.startsWith('\n'));
    if (candidates.length > 0 || emptyTask) {
      // Resolve unfinished wrappers with the same grammar, rather than treating markers in
      // an autolink or an escape as a pending format. No draft content is changed.
      const filled = formattingRanges(`${before}x${after}`) ?? [];
      for (const [kind] of candidates) {
        active.delete(kind);
        if (
          filled.some(
            (range) =>
              range.kind === kind &&
              range.contentStart <= selection.start &&
              range.contentEnd >= selection.start + 1,
          )
        ) {
          active.delete('code');
          active.add(kind);
        }
      }
      if (
        emptyTask &&
        filled.some(
          (range) =>
            range.kind === 'tasks' &&
            range.start <= selection.start &&
            range.end >= selection.start + 1,
        )
      ) {
        for (const kind of LISTS) active.delete(kind);
        active.add('tasks');
      }
    }
  }
  return active;
};
