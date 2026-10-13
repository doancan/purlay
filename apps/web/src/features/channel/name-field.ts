/**
 * The name field's change: what was typed, put into the name's form (`toChannelName`), with the caret
 * kept where the person is typing. React writing a value that differs from the browser's puts the
 * caret at the end, so a space typed in the middle of `genelsohbet` would send the next letter after
 * `sohbet`; the caret is set again from the converted text before it.
 */
import { flushSync } from 'react-dom';
import { toChannelName } from './channel-name';

export const typeChannelName = (input: HTMLInputElement, set: (name: string) => void): void => {
  const typed = input.value;
  const caret = input.selectionStart ?? typed.length;
  const next = toChannelName(typed);
  const at = Math.min(toChannelName(typed.slice(0, caret)).length, next.length);
  flushSync(() => {
    set(next);
  });
  input.setSelectionRange(at, at);
};
