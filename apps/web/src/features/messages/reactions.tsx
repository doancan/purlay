/**
 * Reactions on a message: the chips under it, and the small picker that adds one.
 *
 * **The server's set is the truth.** Toggling asks the API and the cache is taught the
 * answer (`data/actions.ts`), so a chip is never a guess that has to be rolled back — and
 * two people reacting at once both see both. A chip is a button whose pressed state says
 * whether *this* person is among those who used it (`aria-pressed`): the count alone would
 * not tell a screen reader, and colour alone would not tell anyone.
 *
 * **A chip says who** (D-150): pointed at or focused, its tip names the people — "Alice, Bob and
 * 3 others reacted with 👍" — from the workspace's members as the feed already holds them.
 *
 * **A quick set, not a picker.** `UX.md` §10 leaves an emoji picker beyond a recent/frequent
 * row out of Phase 1; seven are offered, as one row of tiles in a menu — which gives them the
 * keyboard model of one (arrows, Escape back to the trigger) — each named in words, the name
 * of the one reached written under the row, and one already yours marked as chosen.
 */
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Message, Reaction, WorkspaceMember } from '@purlay/types';
import { useDescribeFailure } from '../../data/failure';
import { keys } from '../../data/keys';
import { useActions } from '../../data/actions-provider';
import { useI18n } from '../../i18n/i18n-provider';
import type { MessageKey } from '../../i18n/types';
import { IconButton } from '../../ui/icon-button';
import { Menu, MenuTile, MenuTiles } from '../../ui/menu';
import { useToast } from '../../ui/toast';
import { cn } from '../../ui/cn';
import { Tooltip } from '../../ui/tooltip';
import { useWorkspaceIfAny } from '../shell/workspace';

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

/** How many people a chip's tip names before it counts the rest. */
const NAMED = 3;

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

/**
 * Who reacted, in words: the person themself first as "You", then the others in the order they
 * reacted; past three, two names and a count. A name comes from the workspace's members as the
 * screen already read them — the row is drawn again whenever that list changes, since its
 * usernames come from the same read — then from the usernames the row was given.
 */
const useWho = (
  meId: string,
  usernames: ReadonlyMap<string, string>,
): ((reaction: Reaction) => string) => {
  const { t, format } = useI18n();
  const scope = useWorkspaceIfAny();
  const client = useQueryClient();
  const people =
    scope === null
      ? undefined
      : client.getQueryData<WorkspaceMember[]>(keys.members(scope.workspace.id));
  const nameOf = (id: string): string =>
    people?.find((member) => member.user.id === id)?.user.displayName ??
    usernames.get(id) ??
    t('user.erased');
  return (reaction): string => {
    const ids = [
      ...reaction.userIds.filter((id) => id === meId),
      ...reaction.userIds.filter((id) => id !== meId),
    ];
    const names = ids.map((id) => (id === meId ? t('reaction.you') : nameOf(id)));
    const shown =
      names.length <= NAMED
        ? names
        : [
            ...names.slice(0, NAMED - 1),
            t('reaction.others', { count: names.length - (NAMED - 1) }),
          ];
    return t('reaction.by', { names: format.list(shown), emoji: reaction.emoji });
  };
};

const Chip = ({
  reaction,
  mine,
  who,
  onToggle,
}: {
  readonly reaction: Reaction;
  readonly mine: boolean;
  readonly who: string;
  readonly onToggle: () => void;
}): React.JSX.Element => {
  const { t, format } = useI18n();
  return (
    <Tooltip content={who}>
      <button
        type="button"
        aria-pressed={mine}
        aria-label={t('message.reactionOf', {
          emoji: reaction.emoji,
          count: reaction.userIds.length,
        })}
        onClick={onToggle}
        // A soft pill, as Slack's, Discord's and Linear's are (D-209): no frame at rest, the accent's
        // tint under the pointer — what a click would make it — and yours in it, and in the heavier weight.
        className={cn(
          'inline-flex h-6 items-center gap-1 rounded-pill px-2 text-caption font-medium transition-colors duration-hover ease-standard',
          mine
            ? 'bg-accent-subtle font-semibold text-accent-text'
            : 'bg-surface-200 text-ink-muted hover:bg-accent-subtle hover:text-accent-text',
        )}
      >
        <span aria-hidden="true">{reaction.emoji}</span>
        <span aria-hidden="true" className="font-mono">
          {format.number(reaction.userIds.length)}
        </span>
      </button>
    </Tooltip>
  );
};

/** The chips under a message; nothing at all when nobody has reacted. */
export const ReactionBar = ({
  message,
  meId,
  members,
}: {
  readonly message: Message;
  readonly meId: string;
  /** User id to username, as the row has them: the last place a name is found. */
  readonly members: ReadonlyMap<string, string>;
}): React.JSX.Element | null => {
  const toggle = useToggle(message, meId);
  const who = useWho(meId, members);
  if (message.reactions.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      {message.reactions.map((reaction) => (
        <Chip
          key={reaction.emoji}
          reaction={reaction}
          mine={reaction.userIds.includes(meId)}
          who={who(reaction)}
          onToggle={() => {
            toggle(reaction.emoji);
          }}
        />
      ))}
    </div>
  );
};

/** The control that adds a reaction: a button on the bar opening the quick set as one row. */
export const ReactMenu = ({
  message,
  meId,
  boundary,
  onOpenChange,
}: {
  readonly message: Message;
  readonly meId: string;
  /** The list the row is in: the picker stays inside it, so it never covers the composer. */
  readonly boundary: Element | null;
  readonly onOpenChange: (open: boolean) => void;
}): React.JSX.Element => {
  const { t } = useI18n();
  const toggle = useToggle(message, meId);
  const [reached, setReached] = useState<(typeof QUICK_REACTIONS)[number]['name'] | null>(null);
  return (
    <Menu
      align="start"
      side="top"
      boundary={boundary}
      onOpenChange={(open) => {
        if (!open) setReached(null);
        onOpenChange(open);
      }}
      trigger={<IconButton size="bar" glyph="react" label={t('message.addReaction')} />}
    >
      <MenuTiles>
        {QUICK_REACTIONS.map(({ emoji, name }) => (
          <MenuTile
            key={emoji}
            label={t(name)}
            checked={message.reactions.some((r) => r.emoji === emoji && r.userIds.includes(meId))}
            onHighlight={() => {
              setReached(name);
            }}
            onSelect={() => {
              toggle(emoji);
            }}
          >
            {emoji}
          </MenuTile>
        ))}
      </MenuTiles>
      {/* The words for the one reached; the tiles carry their own names for a screen reader. */}
      <p aria-hidden="true" className="truncate px-2 pt-1 text-caption text-ink-muted">
        {reached === null ? t('message.quickReactions') : t(reached)}
      </p>
    </Menu>
  );
};
