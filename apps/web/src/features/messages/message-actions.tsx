/**
 * What can be done with a message, on the bar its row shows (`UX.md` §3, D-150): React, the slot for
 * Reply, Save, Pin and More — the same square controls, each with its tip and its key.
 *
 * **Where it sits.** On the row's own top edge, in the corner the message is not in: the right for
 * everyone else's, the left for your own. So it never covers the name over a bubble, the words in it,
 * or anything of the row above — it does not reach above its own row at all.
 *
 * **More is on every message.** Copy text, Save and Pin again for whoever looks there, then Edit and
 * Delete on one's own; an owner or an admin may delete anybody's (`API.md`, D-103 §7), and is told
 * that doing so is on the audit trail. **Copy link** is first: the message's own address (D-149),
 * where a screen can say where it is (`useCopyMessageLink` is null outside a workspace).
 */
import { useRef, useState } from 'react';
import type { Message } from '@purlay/types';
import { useCopyMessageLink } from './message-link';
import { useActions } from '../../data/actions-provider';
import { useDescribeFailure } from '../../data/failure';
import { useI18n } from '../../i18n/i18n-provider';
import { Button } from '../../ui/button';
import { cn } from '../../ui/cn';
import { Dialog } from '../../ui/dialog';
import { IconButton } from '../../ui/icon-button';
import { Menu, MenuItem, MenuSeparator } from '../../ui/menu';
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
  /** On the right edge of the conversation: the bar goes to the left corner. */
  readonly outgoing: boolean;
  /** Whether this is the one row showing its bar (`active-row.ts`). */
  readonly shown: boolean;
  /** Reply, from the thread slice, after React. */
  readonly actions?: React.ReactNode;
}

export const MessageActions = ({
  message,
  meId,
  mine,
  outgoing,
  shown,
  actions,
}: MessageActionsProps): React.JSX.Element => {
  const { t } = useI18n();
  const bar = useRef<HTMLDivElement>(null);
  const [boundary, setBoundary] = useState<Element | null>(null);
  // While a menu from the bar is open, the bar stays: focus and the pointer are in the menu.
  const opened = (open: boolean): void => {
    if (open) setBoundary(bar.current?.closest(LIST) ?? null);
    holdRow(message.id, open);
  };
  return (
    <div
      ref={bar}
      data-hover-controls=""
      role="group"
      aria-label={t('message.actions')}
      className={cn(
        'absolute top-0 z-popover flex items-center rounded-lg border-hairline border-border-subtle bg-surface-100 p-1 shadow-float transition-opacity duration-hover ease-standard',
        outgoing ? 'left-2' : 'right-2',
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
  const { remove } = useActions();
  const { show } = useToast();
  const { copy } = useContentPorts();
  const describe = useDescribeFailure();
  const { start } = useEditing();
  const copyLink = useCopyMessageLink();
  const role = useWorkspaceIfAny()?.role;
  const moderating = !mine && (role === 'owner' || role === 'admin');
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
        onOpenChange={onOpenChange}
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
