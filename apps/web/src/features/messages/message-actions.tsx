import { knowledgeInput } from '../threads/knowledge-input';
/**
 * What can be done with a message, on the bar its row shows (`UX.md` §3, D-150): React, the slot for
 * Reply, Save, Pin and More — the same square controls, each with its tip and its key.
 *
 * **Where it sits.** On the row's own top edge, in its right corner, for every message (D-187: they all
 * hang from the left). So it never covers the name over a message, the words in it, or anything of the
 * row above — it does not reach above its own row at all.
 *
 * **More is on every message.** Copy text, Mark unread from here for a member (D-212), Save and Pin
 * again for whoever looks there, then Edit and
 * Delete on one's own; an owner or an admin may delete anybody's (`API.md`, D-103 §7), and is told
 * that doing so is on the audit trail. **Copy link** is first: the message's own address (D-149),
 * where a screen can say where it is (`useCopyMessageLink` is null outside a workspace).
 */
import { useRef, useState } from 'react';
import type { Message } from '@purlay/types';
import { useCopyMessageLink } from './message-link';
import { useActions } from '../../data/actions-provider';
import { useChannels } from '../../data/queries';
import { useDescribeFailure } from '../../data/failure';
import { useI18n } from '../../i18n/i18n-provider';
import { Button } from '../../ui/button';
import { cn } from '../../ui/cn';
import { Dialog } from '../../ui/dialog';
import { IconButton } from '../../ui/icon-button';
import { Menu, MenuItem, MenuSeparator } from '../../ui/menu';
import { holdUnread, releaseUnread } from '../channel/use-mark-read';
import { composerKey, focusComposer, quoteMarkdown, sendToComposer } from '../composer/quote';
import { authorOf } from './author';
import { messageUrl } from './message-link';
import { useToast } from '../../ui/toast';
import { useContentPorts } from '../content/content-ports';
import { PinMenuItem, PinToggle } from '../pins/pin-toggle';
import { SaveMenuItem, SaveToggle } from '../saved/save-toggle';
import { useWorkspaceIfAny } from '../shell/workspace';
import { holdRow } from './active-row';
import { useEditing } from './editing';
import { ReactMenu } from './reactions';

/** The list a row is drawn in: a menu opened from the row stays inside it, above the composer. */
const LIST = '[data-message-list]';

interface MessageActionsProps {
  readonly message: Message;
  readonly meId: string;
  /** The author's own, sent and not deleted: theirs to edit and delete. */
  readonly mine: boolean;
  /** The row the bar is on, held while a menu from it is open (`active-row.ts`). */
  readonly rowKey: string;
  /** Whether this is the one row showing its bar (`active-row.ts`). */
  readonly shown: boolean;
  /** Reply, from the thread slice, after React. */
  readonly actions?: React.ReactNode;
}

/** How long a closed menu keeps its row the one when focus lands nowhere. */
const RELEASE_BOUND_MS = 1_000;

export const MessageActions = ({
  message,
  meId,
  mine,
  rowKey,
  shown,
  actions,
}: MessageActionsProps): React.JSX.Element => {
  const { t } = useI18n();
  const bar = useRef<HTMLDivElement>(null);
  const [boundary, setBoundary] = useState<Element | null>(null);
  // While a menu from the bar is open, the bar stays: focus and the pointer are in the menu.
  const opened = (open: boolean): void => {
    if (open) {
      setBoundary(bar.current?.closest(LIST) ?? null);
      holdRow(rowKey, true);
      return;
    }
    // Let go once focus has landed — back on the trigger, after the menu's closing motion, or
    // wherever the person went. Let go at once, the bar went inert before focus could return to its
    // trigger, and a keyboard's Escape left focus nowhere. A second is the bound if nothing is focused.
    const release = (): void => {
      document.removeEventListener('focusin', release);
      clearTimeout(bound);
      holdRow(rowKey, false);
    };
    const bound = setTimeout(release, RELEASE_BOUND_MS);
    document.addEventListener('focusin', release);
  };
  return (
    <div
      ref={bar}
      data-hover-controls=""
      role="group"
      aria-label={t('message.actions')}
      // Not the one row: out of the Tab order and the accessibility tree, as it is out of reach of a
      // click. Tab then reaches the feed's one row (its roving stop) instead of five buttons on every
      // message above it; focusing a row, or the pointer on it, brings its bar back.
      inert={!shown}
      className={cn(
        'absolute top-0 z-popover flex items-center rounded-lg border-hairline border-border-subtle bg-surface-100 p-1 shadow-float transition-opacity duration-hover ease-standard',
        'right-2',
        // Hidden, it must not take a click meant for what is under it.
        !shown && 'pointer-events-none opacity-0',
      )}
    >
      <ReactMenu message={message} meId={meId} boundary={boundary} onOpenChange={opened} />
      {actions}
      <SaveToggle message={message} />
      <PinToggle message={message} />
      <MoreMenu message={message} mine={mine} boundary={boundary} onOpenChange={opened} />
    </div>
  );
};

/**
 * Quote reply (D-213): the part of the message the person selected, or all of it, into the composer it
 * answers in — the thread's for a reply, the channel's for a root.
 */
const useQuoteReply = (): ((message: Message, selected: string | null) => boolean) => {
  const { t } = useI18n();
  const { show } = useToast();
  const slug = useWorkspaceIfAny()?.workspace.slug ?? null;
  return (message, selected) => {
    const author = authorOf(message, t('user.erased')).displayName;
    const link = slug === null ? null : messageUrl(window.location.origin, slug, message);
    const sent = sendToComposer(
      composerKey(message.channelId, message.parentId),
      quoteMarkdown(selected ?? message.content, author, link),
    );
    // A reply quoted while its thread is closed has no composer to go to: say where to open it.
    if (!sent) show({ message: t('message.quoteNowhere') });
    return sent;
  };
};

/**
 * The words the person selected inside this message, or null when the selection is elsewhere. Read
 * as the menu opens: choosing an item can move the selection before the item is told.
 */
const selectedIn = (messageId: string): string | null => {
  const selection = window.getSelection();
  if (selection === null || selection.isCollapsed) return null;
  const inside = (node: Node | null): boolean =>
    (node instanceof Element ? node : node?.parentElement)
      ?.closest('[data-message-id]')
      ?.getAttribute('data-message-id') === messageId;
  if (!inside(selection.anchorNode) || !inside(selection.focusNode)) return null;
  const words = selection.toString().trim();
  return words === '' ? null : words;
};

const MoreMenu = ({
  message,
  mine,
  boundary,
  onOpenChange,
}: {
  readonly message: Message;
  readonly mine: boolean;
  readonly boundary: Element | null;
  readonly onOpenChange: (open: boolean) => void;
}): React.JSX.Element => {
  const { t } = useI18n();
  const actions = useActions();
  const { remove, setKnowledge } = actions;
  const { show } = useToast();
  const { copy } = useContentPorts();
  const describe = useDescribeFailure();
  const { start } = useEditing();
  const copyLink = useCopyMessageLink();
  const scope = useWorkspaceIfAny();
  const role = scope?.role;
  const channels = useChannels(scope?.workspace.id ?? '', scope !== null);
  const member =
    channels.data?.some((channel) => channel.id === message.channelId && channel.state !== null) ===
    true;
  const moderating = !mine && (role === 'owner' || role === 'admin');
  const quote = useQuoteReply();
  // A quote puts focus in its composer; the menu must not take it back to its button as it closes.
  const focusMoved = useRef(false);
  const selected = useRef<string | null>(null);
  const [asking, setAsking] = useState(false);

  const confirm = (): void => {
    setAsking(false);
    remove(message).catch((failure: unknown) => {
      show({ message: `${t('message.deleteFailed')} ${describe(failure)}` });
    });
  };

  return (
    <>
      <Menu
        align="end"
        side="top"
        boundary={boundary}
        onOpenChange={(open) => {
          if (open) {
            focusMoved.current = false;
            selected.current = selectedIn(message.id);
          }
          onOpenChange(open);
        }}
        returnFocus={() => {
          if (!focusMoved.current) return true;
          // Closed now: the quote's composer takes focus instead of the button (D-213).
          focusComposer(composerKey(message.channelId, message.parentId));
          return false;
        }}
        // Edit needs nothing to put focus in its editor: the bar is not drawn while a message is
        // edited, so the menu has no button to give focus back to, and the editor takes it.
        trigger={<IconButton size="bar" glyph="more" label={t('message.more')} />}
      >
        {copyLink !== null && (
          <MenuItem
            glyph="invite"
            onSelect={() => {
              copyLink(message);
            }}
          >
            {t('message.copyLink')}
          </MenuItem>
        )}
        <MenuItem
          glyph="copy"
          onSelect={() => {
            copy(message.content).then(
              () => {
                show({ message: t('common.copied') });
              },
              () => {
                show({ message: t('failure.copy') });
              },
            );
          }}
        >
          {t('message.copyText')}
        </MenuItem>
        {member && message.parentId === null && message.deletedAt === null && (
          <MenuItem
            glyph="open-question"
            onSelect={() => {
              const input = knowledgeInput(message);
              void setKnowledge(message, {
                ...input,
                isQuestion: !input.isQuestion,
                assigneeId: null,
              }).catch((failure: unknown) => show({ message: describe(failure) }));
            }}
          >
            {t(
              message.thread?.knowledge?.isQuestion === true
                ? 'knowledge.unmark'
                : 'knowledge.mark',
            )}
          </MenuItem>
        )}
        {member && message.deletedAt === null && (
          <MenuItem
            glyph="quote"
            onSelect={() => {
              focusMoved.current = quote(message, selected.current);
            }}
          >
            {t('message.quoteReply')}
          </MenuItem>
        )}
        {member && message.deletedAt === null && (
          <MenuItem
            glyph="notifications"
            onSelect={() => {
              // Held first, so a read already waiting for its pause cannot undo it (D-212).
              holdUnread(actions, message.channelId);
              actions.markUnread(message.channelId, message.id).catch((failure: unknown) => {
                releaseUnread(actions, message.channelId);
                show({ message: `${t('message.unreadFailed')} ${describe(failure)}` });
              });
            }}
          >
            {t('message.markUnread')}
          </MenuItem>
        )}
        <SaveMenuItem message={message} />
        <PinMenuItem message={message} />
        {(mine || moderating) && <MenuSeparator />}
        {mine && (
          <MenuItem
            glyph="edit"
            shortcut="E"
            onSelect={() => {
              start(message.id);
            }}
          >
            {t('message.edit')}
          </MenuItem>
        )}
        {(mine || moderating) && (
          <MenuItem
            glyph="delete"
            tone="danger"
            onSelect={() => {
              setAsking(true);
            }}
          >
            {t('message.delete')}
          </MenuItem>
        )}
      </Menu>
      <Dialog
        open={asking}
        onOpenChange={setAsking}
        title={t('message.deleteTitle')}
        description={t(moderating ? 'message.deleteBodyModerated' : 'message.deleteBody')}
        closeLabel={t('common.close')}
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => {
                setAsking(false);
              }}
            >
              {t('common.cancel')}
            </Button>
            <Button variant="danger" glyph="delete" onClick={confirm}>
              {t('message.delete')}
            </Button>
          </>
        }
      >
        {null}
      </Dialog>
    </>
  );
};
