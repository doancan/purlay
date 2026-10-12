/**
 * Reactions on a message: the chips under it, and the small menu that adds one.
 *
 * **The server's set is the truth.** Toggling asks the API and the cache is taught the
 * answer (`data/actions.ts`), so a chip is never a guess that has to be rolled back — and
 * two people reacting at once both see both. A chip is a button whose pressed state says
 * whether *this* person is among those who used it (`aria-pressed`): the count alone would
 * not tell a screen reader, and colour alone would not tell anyone.
 *
 * **A quick set, not a picker.** `UX.md` §10 leaves an emoji picker beyond a recent/frequent
 * row out of Phase 1; seven are offered, named in words, in a menu — which gives them the
 * keyboard model of one (arrows, type-ahead, Escape back to the trigger).
 */
import { useDescribeFailure } from '../../data/failure';
import type { Message, Reaction } from '@purlay/types';
import { Icon } from '../../components/icon';
import { useActions } from '../../data/actions-provider';
import { useI18n } from '../../i18n/i18n-provider';
import type { MessageKey } from '../../i18n/types';
import { Menu, MenuItem, MenuLabel } from '../../ui/menu';
import { useToast } from '../../ui/toast';

/** The emoji offered, and the words that name each one. */
export const QUICK_REACTIONS = [
  { emoji: '👍', name: 'reaction.thumbsUp' },
  { emoji: '❤️', name: 'reaction.heart' },
  { emoji: '🎉', name: 'reaction.celebrate' },
  { emoji: '👀', name: 'reaction.eyes' },
  { emoji: '🚀', name: 'reaction.rocket' },
  { emoji: '✅', name: 'reaction.done' },
  { emoji: '😄', name: 'reaction.smile' },
] as const satisfies readonly { readonly emoji: string; readonly name: MessageKey }[];

/** Adds the person's reaction, or takes it back when it is already there; says so if it fails. */
const useToggle = (message: Message, meId: string): ((emoji: string) => void) => {
  const { react, unreact } = useActions();
  const { show } = useToast();
  const { t } = useI18n();
  const describe = useDescribeFailure();
  return (emoji): void => {
    const mine = message.reactions.some((r) => r.emoji === emoji && r.userIds.includes(meId));
    (mine ? unreact(message, emoji) : react(message, emoji)).catch((failure: unknown) => {
      show({ message: `${t('message.reactionFailed')} ${describe(failure)}` });
    });
  };
};

const Chip = ({
  reaction,
  mine,
  onToggle,
}: {
  readonly reaction: Reaction;
  readonly mine: boolean;
  readonly onToggle: () => void;
}): React.JSX.Element => {
  const { t, format } = useI18n();
  return (
    <button
      type="button"
      aria-pressed={mine}
      aria-label={t('message.reactionOf', {
        emoji: reaction.emoji,
        count: reaction.userIds.length,
      })}
      onClick={onToggle}
      className={
        mine
          ? 'inline-flex h-6 items-center gap-1 rounded-sm border-hairline border-accent-text bg-accent-subtle px-2 text-caption font-medium text-accent-text'
          : 'inline-flex h-6 items-center gap-1 rounded-sm border-hairline border-border-subtle bg-surface-050 px-2 text-caption font-medium text-ink-muted transition-colors duration-hover ease-standard hover:border-ink-muted'
      }
    >
      <span aria-hidden="true">{reaction.emoji}</span>
      <span aria-hidden="true" className="font-mono">
        {format.number(reaction.userIds.length)}
      </span>
    </button>
  );
};

/** The chips under a message; nothing at all when nobody has reacted. */
export const ReactionBar = ({
  message,
  meId,
}: {
  readonly message: Message;
  readonly meId: string;
}): React.JSX.Element | null => {
  const toggle = useToggle(message, meId);
  if (message.reactions.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      {message.reactions.map((reaction) => (
        <Chip
          key={reaction.emoji}
          reaction={reaction}
          mine={reaction.userIds.includes(meId)}
          onToggle={() => {
            toggle(reaction.emoji);
          }}
        />
      ))}
    </div>
  );
};

/** The control that adds a reaction: a button opening the quick set. */
export const ReactMenu = ({
  message,
  meId,
}: {
  readonly message: Message;
  readonly meId: string;
}): React.JSX.Element => {
  const { t } = useI18n();
  const toggle = useToggle(message, meId);
  return (
    <Menu
      align="end"
      trigger={
        <button
          type="button"
          aria-label={t('message.addReaction')}
          className="inline-flex h-6 aspect-square items-center justify-center rounded-sm border-hairline border-dashed border-border-strong bg-surface-050 text-ink-muted transition-colors duration-hover ease-standard hover:border-solid hover:text-ink"
        >
          <Icon name="react" />
        </button>
      }
    >
      <MenuLabel>{t('message.quickReactions')}</MenuLabel>
      {QUICK_REACTIONS.map(({ emoji, name }) => (
        <MenuItem
          key={emoji}
          onSelect={() => {
            toggle(emoji);
          }}
        >
          <span aria-hidden="true">{emoji}</span> {t(name)}
        </MenuItem>
      ))}
    </Menu>
  );
};
