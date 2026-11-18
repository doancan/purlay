/**
 * The emoji a colon can name, and which of them a query matches (`emoji-shortcodes.ts` says where one is
 * typed). Loaded on the first colon, as the picker's grid is on its first open: a person who never types
 * a colon never downloads it.
 *
 * Names are folded as the mention list folds them (`fold`): no case, no Turkish marks.
 */
import { QUERY_MIN, type ShortcodeEntry, type ShortcodeQuery } from './emoji-shortcodes';
import { fold } from './mention-suggest';

/** The most emoji the list shows: past this a person types another letter, they do not scroll. */
export const SHORTCODES_MAX = 8;

/** The names people know from other chat tools, one emoji each, in the groups of the picker. */
export const EMOJI_SHORTCODES: readonly ShortcodeEntry[] = [
  { name: 'smile', emoji: '😄' },
  { name: 'grin', emoji: '😁' },
  { name: 'joy', emoji: '😂' },
  { name: 'rofl', emoji: '🤣' },
  { name: 'slightly_smiling_face', emoji: '🙂' },
  { name: 'upside_down_face', emoji: '🙃' },
  { name: 'wink', emoji: '😉' },
  { name: 'blush', emoji: '😊' },
  { name: 'innocent', emoji: '😇' },
  { name: 'heart_eyes', emoji: '😍' },
  { name: 'star_struck', emoji: '🤩' },
  { name: 'kissing_heart', emoji: '😘' },
  { name: 'yum', emoji: '😋' },
  { name: 'stuck_out_tongue', emoji: '😛' },
  { name: 'stuck_out_tongue_winking_eye', emoji: '😜' },
  { name: 'thinking', emoji: '🤔' },
  { name: 'zipper_mouth', emoji: '🤐' },
  { name: 'neutral_face', emoji: '😐' },
  { name: 'expressionless', emoji: '😑' },
  { name: 'smirk', emoji: '😏' },
  { name: 'unamused', emoji: '😒' },
  { name: 'roll_eyes', emoji: '🙄' },
  { name: 'grimacing', emoji: '😬' },
  { name: 'relieved', emoji: '😌' },
  { name: 'pensive', emoji: '😔' },
  { name: 'sleepy', emoji: '😪' },
  { name: 'sleeping', emoji: '😴' },
  { name: 'mask', emoji: '😷' },
  { name: 'nerd_face', emoji: '🤓' },
  { name: 'sunglasses', emoji: '😎' },
  { name: 'partying_face', emoji: '🥳' },
  { name: 'confused', emoji: '😕' },
  { name: 'worried', emoji: '😟' },
  { name: 'frowning', emoji: '🙁' },
  { name: 'open_mouth', emoji: '😮' },
  { name: 'astonished', emoji: '😲' },
  { name: 'flushed', emoji: '😳' },
  { name: 'pleading_face', emoji: '🥺' },
  { name: 'cry', emoji: '😢' },
  { name: 'sob', emoji: '😭' },
  { name: 'scream', emoji: '😱' },
  { name: 'cold_sweat', emoji: '😰' },
  { name: 'sweat_smile', emoji: '😅' },
  { name: 'triumph', emoji: '😤' },
  { name: 'rage', emoji: '😡' },
  { name: 'exploding_head', emoji: '🤯' },
  { name: 'face_palm', emoji: '🤦' },
  { name: 'shrug', emoji: '🤷' },
  { name: 'saluting_face', emoji: '🫡' },
  { name: 'melting_face', emoji: '🫠' },
  { name: 'skull', emoji: '💀' },
  { name: 'ghost', emoji: '👻' },
  { name: 'robot', emoji: '🤖' },
  { name: 'poop', emoji: '💩' },
  { name: 'see_no_evil', emoji: '🙈' },
  { name: 'thumbsup', emoji: '👍' },
  { name: '+1', emoji: '👍' },
  { name: 'thumbsdown', emoji: '👎' },
  { name: '-1', emoji: '👎' },
  { name: 'ok_hand', emoji: '👌' },
  { name: 'pinched_fingers', emoji: '🤌' },
  { name: 'v', emoji: '✌️' },
  { name: 'crossed_fingers', emoji: '🤞' },
  { name: 'metal', emoji: '🤘' },
  { name: 'wave', emoji: '👋' },
  { name: 'raised_hand', emoji: '✋' },
  { name: 'clap', emoji: '👏' },
  { name: 'raised_hands', emoji: '🙌' },
  { name: 'open_hands', emoji: '👐' },
  { name: 'pray', emoji: '🙏' },
  { name: 'handshake', emoji: '🤝' },
  { name: 'muscle', emoji: '💪' },
  { name: 'point_up', emoji: '☝️' },
  { name: 'point_right', emoji: '👉' },
  { name: 'point_left', emoji: '👈' },
  { name: 'point_down', emoji: '👇' },
  { name: 'eyes', emoji: '👀' },
  { name: 'brain', emoji: '🧠' },
  { name: 'bulb', emoji: '💡' },
  { name: 'heart', emoji: '❤️' },
  { name: 'orange_heart', emoji: '🧡' },
  { name: 'yellow_heart', emoji: '💛' },
  { name: 'green_heart', emoji: '💚' },
  { name: 'blue_heart', emoji: '💙' },
  { name: 'purple_heart', emoji: '💜' },
  { name: 'black_heart', emoji: '🖤' },
  { name: 'broken_heart', emoji: '💔' },
  { name: 'sparkling_heart', emoji: '💖' },
  { name: 'fire', emoji: '🔥' },
  { name: 'sparkles', emoji: '✨' },
  { name: 'star', emoji: '⭐' },
  { name: 'zap', emoji: '⚡' },
  { name: 'boom', emoji: '💥' },
  { name: 'tada', emoji: '🎉' },
  { name: 'confetti_ball', emoji: '🎊' },
  { name: 'balloon', emoji: '🎈' },
  { name: 'gift', emoji: '🎁' },
  { name: 'trophy', emoji: '🏆' },
  { name: 'medal', emoji: '🏅' },
  { name: 'rocket', emoji: '🚀' },
  { name: 'hundred', emoji: '💯' },
  { name: 'white_check_mark', emoji: '✅' },
  { name: 'heavy_check_mark', emoji: '✔️' },
  { name: 'x', emoji: '❌' },
  { name: 'warning', emoji: '⚠️' },
  { name: 'no_entry', emoji: '⛔' },
  { name: 'question', emoji: '❓' },
  { name: 'exclamation', emoji: '❗' },
  { name: 'bangbang', emoji: '‼️' },
  { name: 'info', emoji: 'ℹ️' },
  { name: 'rotating_light', emoji: '🚨' },
  { name: 'construction', emoji: '🚧' },
  { name: 'lock', emoji: '🔒' },
  { name: 'unlock', emoji: '🔓' },
  { name: 'key', emoji: '🔑' },
  { name: 'shield', emoji: '🛡️' },
  { name: 'bug', emoji: '🐛' },
  { name: 'ladybug', emoji: '🐞' },
  { name: 'beetle', emoji: '🪲' },
  { name: 'hammer', emoji: '🔨' },
  { name: 'wrench', emoji: '🔧' },
  { name: 'gear', emoji: '⚙️' },
  { name: 'toolbox', emoji: '🧰' },
  { name: 'package', emoji: '📦' },
  { name: 'memo', emoji: '📝' },
  { name: 'book', emoji: '📖' },
  { name: 'books', emoji: '📚' },
  { name: 'bookmark', emoji: '🔖' },
  { name: 'link', emoji: '🔗' },
  { name: 'paperclip', emoji: '📎' },
  { name: 'pushpin', emoji: '📌' },
  { name: 'calendar', emoji: '📅' },
  { name: 'clock', emoji: '🕐' },
  { name: 'hourglass', emoji: '⏳' },
  { name: 'stopwatch', emoji: '⏱️' },
  { name: 'alarm_clock', emoji: '⏰' },
  { name: 'chart_with_upwards_trend', emoji: '📈' },
  { name: 'chart_with_downwards_trend', emoji: '📉' },
  { name: 'bar_chart', emoji: '📊' },
  { name: 'mag', emoji: '🔍' },
  { name: 'bell', emoji: '🔔' },
  { name: 'mute', emoji: '🔇' },
  { name: 'speech_balloon', emoji: '💬' },
  { name: 'thought_balloon', emoji: '💭' },
  { name: 'email', emoji: '📧' },
  { name: 'inbox_tray', emoji: '📥' },
  { name: 'outbox_tray', emoji: '📤' },
  { name: 'computer', emoji: '💻' },
  { name: 'keyboard', emoji: '⌨️' },
  { name: 'phone', emoji: '📱' },
  { name: 'cloud', emoji: '☁️' },
  { name: 'globe', emoji: '🌍' },
  { name: 'sun', emoji: '☀️' },
  { name: 'moon', emoji: '🌙' },
  { name: 'rainbow', emoji: '🌈' },
  { name: 'umbrella', emoji: '☔' },
  { name: 'snowflake', emoji: '❄️' },
  { name: 'coffee', emoji: '☕' },
  { name: 'tea', emoji: '🍵' },
  { name: 'beer', emoji: '🍺' },
  { name: 'pizza', emoji: '🍕' },
  { name: 'cake', emoji: '🍰' },
  { name: 'cookie', emoji: '🍪' },
  { name: 'apple', emoji: '🍎' },
  { name: 'dog', emoji: '🐶' },
  { name: 'cat', emoji: '🐱' },
  { name: 'unicorn', emoji: '🦄' },
  { name: 'turtle', emoji: '🐢' },
  { name: 'snail', emoji: '🐌' },
  { name: 'seedling', emoji: '🌱' },
  { name: 'tree', emoji: '🌳' },
  { name: 'house', emoji: '🏠' },
  { name: 'car', emoji: '🚗' },
  { name: 'airplane', emoji: '✈️' },
  { name: 'arrow_right', emoji: '➡️' },
  { name: 'arrow_left', emoji: '⬅️' },
  { name: 'arrow_up', emoji: '⬆️' },
  { name: 'arrow_down', emoji: '⬇️' },
  { name: 'repeat', emoji: '🔁' },
  { name: 'recycle', emoji: '♻️' },
  { name: 'money_with_wings', emoji: '💸' },
  { name: 'moneybag', emoji: '💰' },
  { name: 'red_circle', emoji: '🔴' },
  { name: 'large_orange_circle', emoji: '🟠' },
  { name: 'large_yellow_circle', emoji: '🟡' },
  { name: 'large_green_circle', emoji: '🟢' },
  { name: 'large_blue_circle', emoji: '🔵' },
  { name: 'checkered_flag', emoji: '🏁' },
];

const FOLDED: readonly { readonly entry: ShortcodeEntry; readonly folded: string }[] =
  EMOJI_SHORTCODES.map((entry) => ({ entry, folded: fold(entry.name) }));

/**
 * The emoji whose name matches, best first: the name typed out, then names that start with the query,
 * then names with a word (`_`-separated) that does, then names that contain it. Alphabetical inside a
 * tier, so the same letters always give the same list.
 *
 * **A name typed out in full, matching no other, offers nothing.** There is nothing left to complete,
 * and a list would take the Enter that sends the message.
 */
export const suggestShortcodes = (query: string): readonly ShortcodeEntry[] => {
  const q = fold(query);
  if (q.length < QUERY_MIN) return [];
  const ranked: { readonly entry: ShortcodeEntry; readonly tier: number }[] = [];
  for (const { entry, folded } of FOLDED) {
    const tier =
      folded === q
        ? -1
        : folded.startsWith(q)
          ? 0
          : folded.split('_').some((word) => word.startsWith(q))
            ? 1
            : folded.includes(q)
              ? 2
              : null;
    if (tier !== null) ranked.push({ entry, tier });
  }
  ranked.sort((a, b) => a.tier - b.tier || a.entry.name.localeCompare(b.entry.name));
  const [only, ...others] = ranked;
  if (only !== undefined && others.length === 0 && only.tier === -1) return [];
  return ranked.slice(0, SHORTCODES_MAX).map((item) => item.entry);
};

/** The emoji a name stands for exactly, or undefined: what the closing colon of `:tada:` turns into. */
export const shortcodeNamed = (name: string): string | undefined => {
  const q = fold(name);
  return FOLDED.find((item) => item.folded === q)?.entry.emoji;
};

/** The text with the colon and what was typed after it replaced by the emoji, and the caret past it. */
export const insertShortcode = (
  text: string,
  at: ShortcodeQuery,
  emoji: string,
): { readonly text: string; readonly caret: number } => {
  const end = at.start + 1 + at.query.length;
  const head = text.slice(0, at.start) + emoji;
  return { text: head + text.slice(end), caret: head.length };
};

/** The key parts of a keyboard event this module reads. */
interface KeyPress {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
}

/**
 * What a key does to the emoji autocomplete, or null when it is not the list's: the index to move to
 * (↑ ↓ wrap), the emoji to write (Enter or Tab on the current one, or the closing colon of a name written
 * out, list showing or not), or `'close'` (Esc). Enter never sends while the list is open.
 */
export const shortcodeKey = (
  event: KeyPress,
  query: string,
  choices: readonly ShortcodeEntry[],
  current: number,
): number | ShortcodeEntry | 'close' | null => {
  const plain = !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey;
  if (event.key === ':' && plain) {
    const emoji = shortcodeNamed(query);
    return emoji === undefined ? null : { name: query, emoji };
  }
  if (choices.length === 0) return null;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    return (current + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length;
  }
  if ((event.key === 'Enter' || event.key === 'Tab') && plain) return choices[current] ?? null;
  return event.key === 'Escape' ? 'close' : null;
};
