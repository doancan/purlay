/**
 * Forward (D-217): a message sent on to another channel or conversation, with a note if the person
 * wants one — as a message of their own whose last line is the original's link, which every reader
 * sees as a card if, and only if, they may see the original (`message-cards.tsx`).
 *
 * Nothing new is stored: the forward is a message, sent the way the composer sends one (through the
 * engine, so it paints at once and waits in the outbox when offline). The destinations are the channels
 * and conversations the person is in, found by name.
 */
import { useMemo, useState } from 'react';
import type { Channel, Message } from '@purlay/types';
import { MESSAGE_CONTENT_MAX } from '@purlay/types';
import { Icon } from '../../components/icon';
import { useChannels } from '../../data/queries';
import { useI18n } from '../../i18n/i18n-provider';
import { href } from '../../router/routes';
import { useRoute } from '../../router/router-provider';
import { useEngine } from '../../realtime/realtime-provider';
import { Button } from '../../ui/button';
import { cn } from '../../ui/cn';
import { Dialog } from '../../ui/dialog';
import { TextField } from '../../ui/text-field';
import { useToast } from '../../ui/toast';
import { useChannelTitle } from '../channel/channel-header';
import { fold } from '../composer/mention-suggest';
import { useWorkspace } from '../shell/workspace';
import { messageUrl } from './message-link';

/** The forward's words: the note, then the original's link on a line of its own. */
const forwardContent = (note: string, link: string): string => {
  const words = note.trim();
  return words === '' ? link : `${words}\n\n${link}`;
};

const Destination = ({
  channel,
  chosen,
  onChoose,
}: {
  readonly channel: Channel;
  readonly chosen: boolean;
  readonly onChoose: () => void;
}): React.JSX.Element => {
  const title = useChannelTitle(channel);
  return (
    <button
      type="button"
      role="radio"
      aria-checked={chosen}
      onClick={onChoose}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-body transition-colors duration-hover ease-standard',
        chosen ? 'bg-accent-subtle text-accent-text' : 'text-ink hover:bg-surface-200',
      )}
    >
      <Icon
        name={
          channel.type === 'private'
            ? 'private-channel'
            : channel.type === 'public'
              ? 'channel'
              : 'person'
        }
        size="sm"
      />
      <span className="min-w-0 flex-1 truncate">{title}</span>
      {chosen && <Icon name="confirm" size="sm" />}
    </button>
  );
};

/** The name a destination is found by: its own, or for a conversation, its people's. */
const nameOf = (channel: Channel): string =>
  channel.name ?? channel.peers.map((peer) => peer.displayName).join(' ');

export const ForwardDialog = ({
  message,
  open,
  onOpenChange,
}: {
  readonly message: Message;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}): React.JSX.Element => {
  const { t } = useI18n();
  const { workspace } = useWorkspace();
  const { navigate } = useRoute();
  const engine = useEngine();
  const { show } = useToast();
  const channels = useChannels(workspace.id).data;
  const [find, setFind] = useState('');
  const [chosen, setChosen] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const joined = useMemo(
    () => (channels ?? []).filter((channel) => channel.state !== null),
    [channels],
  );
  const wanted = fold(find.trim());
  const shown =
    wanted === '' ? joined : joined.filter((channel) => fold(nameOf(channel)).includes(wanted));
  const target = joined.find((channel) => channel.id === chosen);
  const content = forwardContent(note, messageUrl(window.location.origin, workspace.slug, message));
  const tooLong = content.length > MESSAGE_CONTENT_MAX;

  const close = (): void => {
    onOpenChange(false);
    setFind('');
    setChosen(null);
    setNote('');
  };

  const send = (): void => {
    if (target === undefined || tooLong) return;
    engine.send({ channelId: target.id, content, attachments: [] });
    close();
    show({
      message: t('forward.sent'),
      actionLabel: t('forward.open'),
      onAction: () => {
        navigate(href('channel', { slug: workspace.slug, channelId: target.id }));
      },
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
        else onOpenChange(true);
      }}
      title={t('forward.title')}
      description={t('forward.body')}
      closeLabel={t('common.close')}
      footer={
        <>
          <Button variant="secondary" onClick={close}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" disabled={target === undefined || tooLong} onClick={send}>
            {t('forward.send')}
          </Button>
        </>
      }
    >
      <TextField
        label={t('forward.find')}
        type="search"
        value={find}
        autoComplete="off"
        onChange={(event) => {
          setFind(event.target.value);
        }}
      />
      <div
        role="radiogroup"
        aria-label={t('forward.to')}
        className="max-h-palette-list overflow-y-auto rounded-lg border-hairline border-border-subtle p-1"
      >
        {shown.length === 0 ? (
          <p className="px-3 py-2 text-label text-ink-muted">{t('forward.none')}</p>
        ) : (
          shown.map((channel) => (
            <Destination
              key={channel.id}
              channel={channel}
              chosen={channel.id === chosen}
              onChoose={() => {
                setChosen(channel.id);
              }}
            />
          ))
        )}
      </div>
      <TextField
        label={t('forward.note')}
        value={note}
        onChange={(event) => {
          setNote(event.target.value);
        }}
      />
      {tooLong && <p className="text-label text-danger-text">{t('forward.tooLong')}</p>}
    </Dialog>
  );
};
