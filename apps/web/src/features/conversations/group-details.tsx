/**
 * A group conversation's details (D-127): who is in it — the person themselves first — and, since
 * its people never change, a way to start a larger conversation from them: New message with these
 * people already picked. The history stays where it was written.
 */
import { useState } from 'react';
import type { Channel } from '@purlay/types';
import { useI18n } from '../../i18n/i18n-provider';
import { Avatar } from '../../ui/avatar';
import { Button } from '../../ui/button';
import { Dialog } from '../../ui/dialog';
import { useSession } from '../session/session';
import { NewConversationDialog } from './new-conversation';

export const GroupDetailsDialog = ({
  channel,
  title,
  open,
  onOpenChange,
}: {
  readonly channel: Channel;
  /** What the person calls it: its people. */
  readonly title: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}): React.JSX.Element => {
  const { t } = useI18n();
  const { user } = useSession();
  const [starting, setStarting] = useState(false);
  const people = [user, ...channel.peers];

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={onOpenChange}
        title={title}
        description={t('conversations.details.description')}
        closeLabel={t('common.close')}
        footer={
          <Button
            glyph="add"
            onClick={() => {
              onOpenChange(false);
              setStarting(true);
            }}
          >
            {t('conversations.details.more')}
          </Button>
        }
      >
        <h3 className="text-label text-ink-muted">{t('conversations.details.people')}</h3>
        <ul className="flex flex-col gap-1">
          {people.map((person) => (
            <li key={person.id} className="flex items-center gap-2">
              <Avatar name={person.displayName} username={person.username} size="sm" />
              <span className="min-w-0 flex-1 truncate text-body text-ink">
                {person.displayName}
                <span className="text-ink-muted">{` @${person.username}`}</span>
                {person.id === user.id ? (
                  <span className="text-ink-muted"> {t('sidebar.you')}</span>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      </Dialog>
      <NewConversationDialog
        key={channel.id}
        open={starting}
        onOpenChange={setStarting}
        startWith={channel.peers.map((person) => person.id)}
      />
    </>
  );
};
