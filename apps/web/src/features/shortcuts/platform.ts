/**
 * Which keyboard a person has, as far as a shortcut's label is concerned.
 *
 * The *behaviour* of `Cmd/Ctrl+K` never depends on this — the listener accepts either
 * modifier — only the words printed on screen do: a Mac user is told ⌘, everyone else
 * Ctrl. The navigator is an argument so a test is on either platform without
 * reaching into `window` (D-46).
 */

/** The part of `navigator` the check reads; `userAgentData` is the modern spelling. */
export interface PlatformSource {
  readonly userAgentData?: { readonly platform?: string };
  readonly platform?: string;
}

export const isMacPlatform = (source: PlatformSource): boolean =>
  /mac|iphone|ipad|ipod/i.test(source.userAgentData?.platform ?? source.platform ?? '');

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
