/**
 * Slash commands (D-214): the composer's half that knows no DOM — which commands there are, the one
 * being typed, and what a line that starts with `/` asks for. Each command is a door to something the
 * product already does (the topic, the level, Deep Work, search…): nothing here is a new capability,
 * and what the server refuses it still refuses.
 *
 * - `//text` sends `/text` as words: the way to start a message with a slash.
 * - An unknown `/word` is not sent: it is a typo far more often than a message, and the composer says
 *   which commands there are.
 */
import { DEEP_WORK_CHOICES, type DeepWorkChoice } from '../shell/deep-work';

export const SLASH_COMMANDS = [
  'me',
  'shrug',
  'topic',
  'mute',
  'unmute',
  'star',
  'unstar',
  'invite',
  'leave',
  'deepwork',
  'search',
] as const;
export type SlashName = (typeof SLASH_COMMANDS)[number];

/** What a line asks for: a command and the words after it, an unknown one, or nothing at all. */
export type SlashLine =
  | { readonly kind: 'command'; readonly name: SlashName; readonly args: string }
  | { readonly kind: 'unknown'; readonly name: string }
  | { readonly kind: 'escaped'; readonly text: string }
  | null;

const LINE = /^\/([a-z]+)(?:[ \t]+([\s\S]*))?$/i;

export const parseSlash = (content: string): SlashLine => {
  if (content.startsWith('//')) return { kind: 'escaped', text: content.slice(1) };
  const match = LINE.exec(content);
  if (match === null) return null;
  const name = (match[1] ?? '').toLowerCase();
  const args = (match[2] ?? '').trim();
  const known = SLASH_COMMANDS.find((command) => command === name);
  return known === undefined ? { kind: 'unknown', name } : { kind: 'command', name: known, args };
};

/**
 * The command being typed — a `/` at the very start and letters up to the caret, no space yet — or
 * null: what the suggestions list follows.
 */
export const slashQuery = (text: string, caret: number): string | null => {
  const typed = text.slice(0, caret);
  const match = /^\/([a-z]*)$/i.exec(typed);
  return match === null ? null : (match[1] ?? '').toLowerCase();
};

/** The commands that start with what was typed, in the list's order. */
export const commandsFor = (query: string): readonly SlashName[] =>
  SLASH_COMMANDS.filter((command) => command.startsWith(query));

/** `/me waves`: the words as an action, in italics, as every chat writes it. */
export const meMessage = (args: string): string | null =>
  args === '' ? null : `_${args.replace(/_/g, '\\_')}_`;

/** `/shrug words`: the words, then the shrug, its backslash kept so the arm is not an escape. */
export const shrugMessage = (args: string): string =>
  `${args === '' ? '' : `${args} `}¯\\\\\\_(ツ)\\_/¯`;

/** `/deepwork 1h`: a while Deep Work knows, `off` to end it, or null for anything else. */
export const deepWorkOf = (args: string): DeepWorkChoice | 'off' | null => {
  const word = args.trim().toLowerCase();
  if (word === 'off' || word === 'end' || word === 'stop') return 'off';
  if (word === '' || word === '1h') return '1h';
  return DEEP_WORK_CHOICES.find((choice) => choice === word) ?? null;
};

/** `/invite @alice`: the handle, without its `@`, or null when none was given. */
export const inviteeOf = (args: string): string | null => {
  const handle = /^@?([\p{L}\p{N}_-]+)$/u.exec(args.trim())?.[1];
  return handle === undefined ? null : handle.toLowerCase();
};
