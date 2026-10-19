/**
 * Which one row shows its actions (`UX.md` §3, D-150): the row under the pointer, or the focused row
 * when the keyboard is in use — never both. Two rows each deciding for themselves (one hovered, one
 * focused) drew two bars at once, which is what this replaces.
 *
 * **One fact for the page, read by every row.** The feed and the thread panel are two lists of rows,
 * and the rule is across both, so the state is the document's: where the pointer is, where focus is,
 * which kind of input came last, and a row whose menu is open — held, so its bar stays while focus
 * and the pointer are in the menu, which is drawn outside the row. A row reads only whether *it* is
 * the one, so a move re-renders the row that lost and the row that gained, and no other.
 *
 * **The nearest row answers.** A row inside another row is its own: what is under the pointer is
 * found by `closest`, so a nested row never lights its parent up.
 *
 * **A finger is not a pointer.** A touch leaves as soon as it lifts, so on a phone the row tapped
 * stays the one until another row, or something else, is tapped.
 */
import { useEffect, useSyncExternalStore } from 'react';

const ROW = '[data-message-row]';

interface State {
  pointer: string | null;
  focus: string | null;
  held: string | null;
  keyboard: boolean;
}

const fresh = (): State => ({ pointer: null, focus: null, held: null, keyboard: false });

let state = fresh();
let active: string | null = null;
const listeners = new Set<() => void>();

/** The row an event happened in, by its id; null outside any row, or in a row with no id. */
const rowOf = (target: EventTarget | null): string | null =>
  target instanceof Element
    ? (target.closest<HTMLElement>(ROW)?.dataset['messageId'] ?? null)
    : null;

const decide = (next: Partial<State>): void => {
  state = { ...state, ...next };
  const now =
    state.held ??
    (state.keyboard ? (state.focus ?? state.pointer) : (state.pointer ?? state.focus));
  if (now === active) return;
  active = now;
  for (const listener of listeners) listener();
};

const onPointerOver = (event: PointerEvent): void => {
  if (event.pointerType === 'touch') return;
  decide({ pointer: rowOf(event.target), keyboard: false });
};
const onPointerLeave = (event: PointerEvent): void => {
  if (event.pointerType === 'touch') return;
  // Leaving the row for nothing — the window's edge — or for nothing that is a row.
  if (event.target instanceof Element && event.target.matches(ROW)) {
    const left = rowOf(event.target);
    if (left === state.pointer && rowOf(event.relatedTarget) !== left) decide({ pointer: null });
  }
};
const onPointerDown = (event: PointerEvent): void => {
  decide({
    keyboard: false,
    ...(event.pointerType === 'touch' ? { pointer: rowOf(event.target) } : {}),
  });
};
const onPointerMove = (event: PointerEvent): void => {
  if (state.keyboard && event.pointerType !== 'touch') decide({ keyboard: false });
};
const onKeyDown = (event: KeyboardEvent): void => {
  if (['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) return;
  decide({ keyboard: true });
};
const onFocus = (event: FocusEvent): void => {
  decide({ focus: rowOf(event.target) });
};
const onBlur = (event: FocusEvent): void => {
  // Focus moving within the same row is not a blur of the row.
  if (rowOf(event.relatedTarget) === null) decide({ focus: null });
};

const EVENTS = [
  ['pointerover', onPointerOver],
  ['pointerleave', onPointerLeave],
  ['pointerdown', onPointerDown],
  ['pointermove', onPointerMove],
  ['keydown', onKeyDown],
  ['focus', onFocus],
  ['blur', onBlur],
] as const;

const listen = (on: boolean): void => {
  for (const [type, handler] of EVENTS) {
    // Captured: focus, blur and pointerleave do not bubble, and a row may stop what does.
    if (on) document.addEventListener(type, handler as EventListener, true);
    else document.removeEventListener(type, handler as EventListener, true);
  }
};

const subscribe = (listener: () => void): (() => void) => {
  if (listeners.size === 0) listen(true);
  listeners.add(listener);
  return (): void => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    // The last row is gone: nothing is remembered for a page drawn afresh — or another document.
    listen(false);
    state = fresh();
    active = null;
  };
};

/** Whether this row is the one showing its actions. */
export const useActiveRow = (messageId: string): boolean => {
  const on = useSyncExternalStore(
    subscribe,
    () => active === messageId,
    () => false,
  );
  // A row that goes while it is the one — deleted under the pointer — leaves nothing behind.
  useEffect(
    () => (): void => {
      const { pointer, focus, held } = state;
      if (pointer === messageId || focus === messageId || held === messageId) {
        decide({
          pointer: pointer === messageId ? null : pointer,
          focus: focus === messageId ? null : focus,
          held: held === messageId ? null : held,
        });
      }
    },
    [messageId],
  );
  return on;
};

/** Keeps a row the one while something it opened — a menu — is open outside it. */
export const holdRow = (messageId: string, holding: boolean): void => {
  if (holding) decide({ held: messageId });
  else if (state.held === messageId) decide({ held: null });
};
