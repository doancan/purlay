/** The curated emoji grid loads only when its menu opens. */
import { useI18n } from '../../../i18n/i18n-provider';
import type { MessageKey } from '../../../i18n/types';
import { MenuTile, MenuTiles } from '../../../ui/menu';

const GROUPS = [
  {
    name: 'emoji.faces',
    emoji: [
      '😀',
      '😄',
      '😁',
      '😂',
      '🙂',
      '😉',
      '😊',
      '😍',
      '🤔',
      '😅',
      '😭',
      '😴',
      '😎',
      '🥳',
      '😬',
      '🙃',
    ],
  },
  {
    name: 'emoji.hands',
    emoji: [
      '👍',
      '👎',
      '👏',
      '🙌',
      '🙏',
      '💪',
      '👋',
      '🤝',
      '👀',
      '🫡',
      '🤞',
      '✌️',
      '👌',
      '🤷',
      '🙋',
      '🫶',
    ],
  },
  {
    name: 'emoji.work',
    emoji: [
      '🚀',
      '✅',
      '❌',
      '⚠️',
      '🔥',
      '💡',
      '🐛',
      '🔧',
      '🛠️',
      '📌',
      '📎',
      '📝',
      '🔒',
      '⏰',
      '📈',
      '🧪',
    ],
  },
  {
    name: 'emoji.symbols',
    emoji: [
      '❤️',
      '💯',
      '🎉',
      '⭐',
      '✨',
      '💥',
      '☕',
      '🍕',
      '🎯',
      '🏆',
      '💬',
      '🔔',
      '➕',
      '➖',
      '❓',
      '❗',
    ],
  },
] as const satisfies readonly { readonly name: MessageKey; readonly emoji: readonly string[] }[];

export const EmojiChoices = ({
  onPick,
}: {
  readonly onPick: (emoji: string) => void;
}): React.JSX.Element => {
  const { t } = useI18n();
  return (
    <>
      {GROUPS.map((group) => (
        <section key={group.name} aria-label={t(group.name)} className="flex flex-col gap-1 pb-1">
          <h3 className="px-2 pt-1 text-caption text-ink-muted">{t(group.name)}</h3>
          <MenuTiles grid>
            {group.emoji.map((emoji) => (
              <MenuTile
                key={emoji}
                label={emoji}
                checked={false}
                fill
                onSelect={() => {
                  onPick(emoji);
                }}
              >
                {emoji}
              </MenuTile>
            ))}
          </MenuTiles>
        </section>
      ))}
    </>
  );
};
