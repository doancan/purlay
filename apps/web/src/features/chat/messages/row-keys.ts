/**
 * The keys that work on a list of message rows (`UX.md` §7): ↑ ↓ Home End move between them, and
 * `E` edits a focused message of one's own. The channel's feed and the thread panel are two such
 * lists, and they answer the same keys the same way because this is the one place that says how.
 */

/** The edit the `E` key starts: the editing slice's `start`. */
type StartEdit = (id: string) => void;

const isTypingTarget = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  (target.matches('input, textarea, select') || target.isContentEditable);

/** Handles a key pressed among `rows`; true when it was one of these. */
export const handleRowKeys = (
  event: React.KeyboardEvent,
  rows: readonly HTMLElement[],
  startEdit: StartEdit,
): boolean => {
  if (isTypingTarget(event.target) || event.metaKey || event.ctrlKey || event.altKey) return false;
  const focusedRow = (event.target as HTMLElement).closest<HTMLElement>('[data-message-row]');
  if (event.key.toLowerCase() === 'e' && focusedRow?.hasAttribute('data-editable') === true) {
    const id = focusedRow.dataset['messageId'];
    if (id !== undefined) {
      event.preventDefault();
      startEdit(id);
      return true;
    }
  }
  const current = rows.findIndex((row) => row === focusedRow);
  let next = -1;
  if (event.key === 'ArrowUp') next = current === -1 ? rows.length - 1 : Math.max(0, current - 1);
  else if (event.key === 'ArrowDown')
    next = current === -1 ? 0 : Math.min(rows.length - 1, current + 1);
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = rows.length - 1;
  const row = rows[next];
  if (row === undefined) return false;
  event.preventDefault();
  row.focus();
  return true;
};
