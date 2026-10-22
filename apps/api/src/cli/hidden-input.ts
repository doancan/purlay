/**
 * The keys of a line typed with nothing shown (`admin-reset-password.ts`), as a pure function of what
 * was typed so far — separable from the terminal so it can be tested without one.
 *
 * - Enter submits; Ctrl-C cancels; Backspace removes the last character.
 * - **Ctrl-D** on an empty line is the end of input — cancelled; on a line with something in it, it
 *   submits (the prompt is only ever asked of a terminal).
 * - **An escape sequence is ignored whole** — an arrow, Home, Delete (`ESC [ … final`, `ESC O x`) — so its
 *   letters never end up in a password; it may arrive split over two reads, which `state` carries.
 */
export interface HiddenLine {
  readonly value: string;
  /** Inside an escape sequence: `'esc'` after ESC, `'csi'` inside `ESC [`, `'ss3'` after `ESC O`. */
  readonly escape: 'esc' | 'csi' | 'ss3' | null;
  readonly done: 'submit' | 'cancel' | null;
}

export const NEW_LINE: HiddenLine = { value: '', escape: null, done: null };

export const typed = (before: HiddenLine, chunk: string): HiddenLine => {
  let { value, escape } = before;
  for (const key of chunk) {
    if (escape === 'esc') {
      escape = key === '[' ? 'csi' : key === 'O' ? 'ss3' : null;
      continue;
    }
    if (escape === 'csi') {
      // Parameters and intermediates are 0x20–0x3f; the final byte, 0x40–0x7e, ends it.
      if (key >= '@' && key <= '~') escape = null;
      continue;
    }
    if (escape === 'ss3') {
      escape = null;
      continue;
    }
    if (key === '\u001b') {
      escape = 'esc';
      continue;
    }
    if (key === '\r' || key === '\n') return { value, escape: null, done: 'submit' };
    if (key === '\u0003') return { value, escape: null, done: 'cancel' };
    if (key === '\u0004') {
      return { value, escape: null, done: value === '' ? 'cancel' : 'submit' };
    }
    if (key === '\u007f' || key === '\b') value = Array.from(value).slice(0, -1).join('');
    else if (key >= ' ') value += key;
  }
  return { value, escape, done: null };
};
