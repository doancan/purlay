/**
 * A shortcut, spelled the way this keyboard prints it.
 *
 * Every shortcut on screen — a menu's column, a tooltip, the composer's hints, the palette, the
 * reference — reaches the screen through `Kbd`, and `Kbd` spells it here, so a Mac shows ⌘ ⇧ ⌥ ⌃ ↵ ⌫
 * esc ⇥ and everyone else Ctrl, Shift, Alt, Enter, Backspace, Esc, Tab, in one place. A shortcut is written
 * in the neutral words (`Mod+K`, `Shift+Enter`, `Esc`) and printed for this keyboard; one already spelled
 * for a platform (`Ctrl+K`, `⌘K`, `⇧Esc`, from `keyLabels`) is read into its keys as written.
 *
 * The *behaviour* of a shortcut never depends on this — the listener accepts either modifier — only the
 * words printed on screen do. The navigator is an argument so a test is on either platform without
 * reaching into `window` (D-46).
 */

/** The part of `navigator` the check reads; `userAgentData` is the modern spelling. */
export interface PlatformSource {
  readonly userAgentData?: { readonly platform?: string };
  readonly platform?: string;
}

export const isMacPlatform = (source: PlatformSource): boolean =>
  /mac|iphone|ipad|ipod/i.test(source.userAgentData?.platform ?? source.platform ?? '');

/** This browser's keyboard; `{}` where there is no navigator (a test without a DOM). */
export const currentPlatformIsMac = (): boolean =>
  isMacPlatform(typeof navigator === 'undefined' ? {} : navigator);

interface KeyName {
  readonly mac: string;
  readonly other: string;
}

/** The keys that are printed differently on a Mac, under every name a caller may give them (lower case). */
const NAMED_KEYS: ReadonlyMap<string, KeyName> = new Map(
  (
    [
      [['mod', 'cmd', 'command', 'meta', '⌘'], { mac: '⌘', other: 'Ctrl' }],
      [['ctrl', 'control', '⌃'], { mac: '⌃', other: 'Ctrl' }],
      [['shift', '⇧'], { mac: '⇧', other: 'Shift' }],
      [['alt', 'option', 'opt', '⌥'], { mac: '⌥', other: 'Alt' }],
      [['enter', 'return', '↵', '⏎'], { mac: '↵', other: 'Enter' }],
      [['esc', 'escape'], { mac: 'esc', other: 'Esc' }],
      [['backspace', '⌫'], { mac: '⌫', other: 'Backspace' }],
      [['delete', 'del', '⌦'], { mac: '⌦', other: 'Delete' }],
      [['tab', '⇥'], { mac: '⇥', other: 'Tab' }],
      [['up', 'arrowup', '↑'], { mac: '↑', other: '↑' }],
      [['down', 'arrowdown', '↓'], { mac: '↓', other: '↓' }],
      [['left', 'arrowleft', '←'], { mac: '←', other: '←' }],
      [['right', 'arrowright', '→'], { mac: '→', other: '→' }],
      [['space', ' '], { mac: 'Space', other: 'Space' }],
    ] as const
  ).flatMap(([names, key]) => names.map((name): [string, KeyName] => [name, key])),
);

/** The Mac's modifier glyphs, written run together in front of a key (`⇧⌘K`). */
const GLYPH_MODIFIERS = new Set(['⌘', '⇧', '⌥', '⌃']);

/** A modifier's word written run together with a key (`CtrlK`, `Ctrl/`), longest first so `Control` wins. */
const WORD_MODIFIER = /^(control|command|option|shift|ctrl|cmd|alt|mod|opt)(?=.)/i;

/** Splits the modifiers written in front of a key without a `+` from the key they modify. */
const peelModifiers = (written: string): readonly string[] => {
  // Each modifier glyph is one UTF-16 unit, so the first unit is the whole glyph when it is one.
  const first = written.charAt(0);
  if (GLYPH_MODIFIERS.has(first) && written.length > 1) {
    return [first, ...peelModifiers(written.slice(1))];
  }
  const word = WORD_MODIFIER.exec(written)?.[0];
  if (word !== undefined) return [word, ...peelModifiers(written.slice(word.length))];
  return [written];
};

/**
 * The keys of a shortcut, in the order they are written: `Ctrl+Shift+R`, `⌘⇧R` and `Mod+Shift+r` are all
 * three keys. A `+` separates keys, except where it is the key (`Ctrl++`).
 */
export const shortcutKeys = (shortcut: string): readonly string[] => {
  const trimmed = shortcut.trim();
  if (trimmed === '') return [];
  if (trimmed === '+') return ['+'];
  const parts = trimmed.endsWith('++')
    ? [...trimmed.slice(0, -2).split('+'), '+']
    : trimmed.split('+');
  const keys = parts.map((part) => part.trim()).filter((part) => part !== '');
  return keys.flatMap((key) => (key === '+' ? [key] : peelModifiers(key)));
};

/** One key as this platform prints it: a named key by its glyph or word, a letter in capitals. */
export const keyCap = (key: string, mac: boolean): string => {
  const named = NAMED_KEYS.get(key.toLowerCase());
  if (named !== undefined) return mac ? named.mac : named.other;
  return isSingleCharacter(key) ? key.toUpperCase() : key;
};

/** One character: a letter, a digit, a glyph — every key the keyboard prints as one sign is a single UTF-16 unit. */
export const isSingleCharacter = (key: string): boolean => key.length === 1;

/** A Mac's own glyphs: a shortcut written with one is already a Mac's. */
const MAC_GLYPHS = new Set(['⌘', '⇧', '⌥', '⌃', '↵', '⏎', '⌫', '⌦', '⇥']);

/**
 * Whether a shortcut is printed as a Mac prints it: on a Mac, or where its caller already spelled it in a
 * Mac's glyphs — a screen told the platform (the reference, a menu given its navigator) knows better than
 * this browser, so its ⌘ is kept, not second-guessed into Ctrl. The words (`Mod`, `Shift`, `Enter`) are
 * the neutral spelling, printed for this keyboard.
 */
export const printsAsMac = (shortcut: string, mac: boolean): boolean =>
  mac || shortcutKeys(shortcut).some((key) => MAC_GLYPHS.has(key));

/** The order a Mac prints its modifiers in, whatever order a feature wrote them (Apple's ⌃ ⌥ ⇧ ⌘). */
const MAC_MODIFIER_ORDER: readonly string[] = ['⌃', '⌥', '⇧', '⌘'];

/** Where a printed cap sorts on a Mac: a modifier by its place in Apple's order, every other key after them. */
const macRank = (cap: string): number => {
  const rank = MAC_MODIFIER_ORDER.indexOf(cap);
  return rank === -1 ? MAC_MODIFIER_ORDER.length : rank;
};

/**
 * A shortcut's keys, each as it is printed (`printsAsMac`). On a Mac the modifiers come in Apple's order,
 * so `Mod+Shift+D` reads ⇧ ⌘ D as the menu bar prints it; the other keys keep the order they were written in.
 */
export const formatShortcut = (shortcut: string, mac: boolean): readonly string[] => {
  const asMac = printsAsMac(shortcut, mac);
  const caps = shortcutKeys(shortcut).map((key) => keyCap(key, asMac));
  return asMac ? caps.toSorted((first, second) => macRank(first) - macRank(second)) : caps;
};
