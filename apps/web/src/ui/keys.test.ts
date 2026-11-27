/**
 * How a shortcut is spelled for a keyboard: the keys a written shortcut is read into, and each key as a Mac
 * and everything else prints it.
 */
import { describe, expect, test } from 'bun:test';
import { formatShortcut, isMacPlatform, keyCap, printsAsMac, shortcutKeys } from './keys';

describe('isMacPlatform', () => {
  test.each([
    [{ platform: 'MacIntel' }, true],
    [{ platform: 'iPhone' }, true],
    [{ platform: 'iPad' }, true],
    [{ userAgentData: { platform: 'macOS' }, platform: 'Win32' }, true],
    [{ platform: 'Win32' }, false],
    [{ platform: 'Linux x86_64' }, false],
    [{ userAgentData: { platform: 'Windows' }, platform: 'MacIntel' }, false],
    [{}, false],
  ] as const)('%o is a Mac: %p', (source, mac) => {
    expect(isMacPlatform(source)).toBe(mac);
  });
});

describe('shortcutKeys', () => {
  test.each([
    ['Ctrl+Shift+R', ['Ctrl', 'Shift', 'R']],
    ['⌘⇧R', ['⌘', '⇧', 'R']],
    ['⇧⌘Q', ['⇧', '⌘', 'Q']],
    ['⌘K', ['⌘', 'K']],
    ['⌘↵', ['⌘', '↵']],
    ['⇧Esc', ['⇧', 'Esc']],
    ['CtrlK', ['Ctrl', 'K']],
    ['Ctrl/', ['Ctrl', '/']],
    ['Ctrl,', ['Ctrl', ',']],
    ['Mod + Shift + p', ['Mod', 'Shift', 'p']],
    ['Ctrl++', ['Ctrl', '+']],
    ['+', ['+']],
    ['Shift', ['Shift']],
    ['Esc', ['Esc']],
    ['F10', ['F10']],
    ['```', ['```']],
    ['⌘', ['⌘']],
    ['', []],
  ] as const)('%p is the keys %p', (written, keys) => {
    expect(shortcutKeys(written)).toEqual(keys);
  });
});

describe('keyCap', () => {
  test.each([
    ['Mod', '⌘', 'Ctrl'],
    ['Cmd', '⌘', 'Ctrl'],
    ['⌘', '⌘', 'Ctrl'],
    ['Ctrl', '⌃', 'Ctrl'],
    ['Shift', '⇧', 'Shift'],
    ['⇧', '⇧', 'Shift'],
    ['Alt', '⌥', 'Alt'],
    ['Option', '⌥', 'Alt'],
    ['Enter', '↵', 'Enter'],
    ['Return', '↵', 'Enter'],
    ['↵', '↵', 'Enter'],
    ['Esc', 'esc', 'Esc'],
    ['Escape', 'esc', 'Esc'],
    ['Backspace', '⌫', 'Backspace'],
    ['Delete', '⌦', 'Delete'],
    ['Tab', '⇥', 'Tab'],
    ['ArrowUp', '↑', '↑'],
    ['↓', '↓', '↓'],
    ['left', '←', '←'],
    ['Right', '→', '→'],
    ['k', 'K', 'K'],
    ['/', '/', '/'],
    ['F10', 'F10', 'F10'],
    ['```', '```', '```'],
  ] as const)('%p is %p on a Mac and %p elsewhere', (key, mac, other) => {
    expect(keyCap(key, true)).toBe(mac);
    expect(keyCap(key, false)).toBe(other);
  });
});

describe('formatShortcut', () => {
  test('the neutral words are printed for the keyboard', () => {
    expect(formatShortcut('Mod+Enter', true)).toEqual(['⌘', '↵']);
    expect(formatShortcut('Mod+Enter', false)).toEqual(['Ctrl', 'Enter']);
    expect(formatShortcut('Shift+Enter', true)).toEqual(['⇧', '↵']);
    expect(formatShortcut('Shift+Enter', false)).toEqual(['Shift', 'Enter']);
    expect(formatShortcut('Alt+↑', true)).toEqual(['⌥', '↑']);
    expect(formatShortcut('Alt+↑', false)).toEqual(['Alt', '↑']);
    expect(formatShortcut('Esc', true)).toEqual(['esc']);
    expect(formatShortcut('Tab', true)).toEqual(['⇥']);
  });

  test('a shortcut already spelled for a platform keeps its keys', () => {
    expect(formatShortcut('⌘⇧R', false)).toEqual(['⇧', '⌘', 'R']);
    // A Mac's chord is a Mac's throughout: its Esc is the Mac's too.
    expect(formatShortcut('⇧Esc', false)).toEqual(['⇧', 'esc']);
    expect(printsAsMac('⌘/', false)).toBe(true);
    expect(printsAsMac('Ctrl+/', false)).toBe(false);
    expect(printsAsMac('Esc', true)).toBe(true);
    expect(formatShortcut('CtrlK', false)).toEqual(['Ctrl', 'K']);
    // Control on a Mac is its own key, not Command.
    expect(formatShortcut('Ctrl+Shift+R', true)).toEqual(['⌃', '⇧', 'R']);
  });

  test('a Mac prints its modifiers in its own order, whatever order they were written in', () => {
    expect(formatShortcut('Mod+Shift+D', true)).toEqual(['⇧', '⌘', 'D']);
    expect(formatShortcut('Mod+Alt+Shift+Ctrl+K', true)).toEqual(['⌃', '⌥', '⇧', '⌘', 'K']);
    // Off a Mac the order is the one written.
    expect(formatShortcut('Mod+Shift+D', false)).toEqual(['Ctrl', 'Shift', 'D']);
  });
});
