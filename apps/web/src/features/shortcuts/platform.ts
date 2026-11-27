/**
 * Which keyboard a person has, as far as a shortcut's label is concerned.
 *
 * The *behaviour* of `Cmd/Ctrl+K` never depends on this — the listener accepts either
 * modifier — only the words printed on screen do: a Mac user is told ⌘, everyone else
 * Ctrl. The navigator is an argument so a test is on either platform without
 * reaching into `window` (D-46).
 */

// The check itself is the key cap's (`ui/keys.ts`), so the words a feature builds and the caps `Kbd` draws
// are spelled for one keyboard.
export { isMacPlatform, type PlatformSource } from '../../ui/keys';

/** The names of the keys a shortcut uses, as printed on this platform. */
export interface KeyLabels {
  readonly mod: string;
  readonly shift: string;
  readonly alt: string;
  readonly enter: string;
  readonly escape: string;
}

export const keyLabels = (mac: boolean): KeyLabels =>
  mac
    ? { mod: '⌘', shift: '⇧', alt: '⌥', enter: '↵', escape: 'Esc' }
    : { mod: 'Ctrl', shift: 'Shift', alt: 'Alt', enter: 'Enter', escape: 'Esc' };
