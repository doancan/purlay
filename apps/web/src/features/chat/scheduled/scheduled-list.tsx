/**
 * The "Scheduled" tab of Drafts and sent: the person's own messages held for later, and the ones the
 * server could not send.
 *
 * The list is the server's — pending and failed, by send time, at most a hundred — and it has no push,
 * so it is read when the tab opens, when the window comes back into focus and after each change made
 * here. Send now takes the row away at once and asks the server to send it by its own delivery, which
 * never sends one twice (D-324). Cancelling says so with Undo, which asks for the same message again under the same id while
 * that is still possible. Editing moves the words back into the place's draft and cancels the schedule,
 * in that order, so nothing is lost when either step fails (`useEditScheduled`).
 */
import { useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { useContext, useMemo, useRef, useState } from 'react';
import type { Channel, ScheduledMessage, ScheduledMessageList } from '@purlay/types';
import { Icon } from '../../../components/icon';
import { useApi } from '../../../data/api-provider';
import { codeOf, useDescribeFailure } from '../../../data/failure';
import { keys } from '../../../data/keys';
import { useI18n } from '../../../i18n/i18n-provider';
import { RealtimePortsContext } from '../../../realtime/realtime-provider';
import { threadHref, href } from '../../../router/routes';
import { useRoute } from '../../../router/router-provider';
import { systemClock } from '../../../system-clock';
import { cn } from '../../../ui/cn';
import { IconButton } from '../../../ui/icon-button';
import { ListCard, listButtonClasses, listRowClasses } from '../../../ui/list-column';
import { LoadingStatus, Skeleton } from '../../../ui/skeleton';
import { ErrorState, GlyphEmptyState } from '../../../ui/states';
import { useToast } from '../../../ui/toast';
import { useSession } from '../../session/session';
import { useWorkspace } from '../../shell/workspace';
import { useChannelTitle } from '../channel/channel-header';
import { ComposerPortsContext, browserPorts } from '../composer/composer-ports';
import { draftKey, readDraft, writeDraft } from '../composer/drafts';
import { Place } from '../drafts/place';
import { describeWhen } from './presets';

/** Why the server could not send it, in a few words: the codes `sendMessage` refuses with at delivery. */
type ReasonKey =
  | 'scheduled.reason.channel'
  | 'scheduled.reason.member'
  | 'scheduled.reason.admins'
  | 'scheduled.reason.parent'
  | 'scheduled.reason.file'
  | 'scheduled.reason.access'
  | 'scheduled.reason.other';

const reasonKey = (code: string | null): ReasonKey => {
  switch (code) {
    case 'CHANNEL_NOT_FOUND':
      return 'scheduled.reason.channel';
    case 'NOT_A_CHANNEL_MEMBER':
      return 'scheduled.reason.member';
    case 'ONLY_ADMINS_POST':
      return 'scheduled.reason.admins';
    case 'MESSAGE_NOT_FOUND':
      return 'scheduled.reason.parent';
    case 'ATTACHMENT_NOT_FOUND':
      return 'scheduled.reason.file';
    case 'FORBIDDEN':
    case 'WORKSPACE_ACCESS_REQUIRED':
    case 'WORKSPACE_NOT_FOUND':
      return 'scheduled.reason.access';
    case null:
    default:
      return 'scheduled.reason.other';
  }
};

const Row = ({
  item,
  channel,
  busy,
  onOpen,
  onSendNow,
  onCancel,
  onEdit,
}: {
  readonly item: ScheduledMessage;
  readonly channel: Channel;
  readonly busy: boolean;
  readonly onOpen: () => void;
  readonly onSendNow: (place: string) => void;
  readonly onCancel: () => void;
  readonly onEdit: (place: string) => void;
}): React.JSX.Element => {
  const { t, format } = useI18n();
  const clock = (useContext(RealtimePortsContext).clock ?? systemClock).now;
  const place = useChannelTitle(channel);
  const failed = item.state === 'failed';
  const sendAt = new Date(item.sendAt);
  return (
    // The actions sit beside the row's button, in the flow, so its words wrap before them; the row is tinted as one.
    <li
      className={cn(
        'flex items-start transition-colors duration-hover ease-standard hover:bg-surface-050',
        listRowClasses,
      )}
    >
      <button
        type="button"
        onClick={onOpen}
        className={listButtonClasses('min-w-0 flex-1 flex-col gap-1 pr-2')}
      >
        <Place channel={channel} thread={item.parentId !== null} />
        <time dateTime={item.sendAt} className="text-caption text-ink-muted">
          {describeWhen(sendAt, clock(), format, t)}
        </time>
        <span className="line-clamp-2 whitespace-pre-wrap text-body text-ink">{item.content}</span>
        {item.attachments.length > 0 && (
          <span className="flex items-center gap-1 text-caption text-ink-muted">
            <Icon name="attach" size="sm" />
            {t('scheduled.files', { count: item.attachments.length })}
          </span>
        )}
        {failed && (
          <span className="flex items-center gap-1 text-label text-danger-text">
            <Icon name="failed" size="sm" />
            {t('scheduled.failed', { reason: t(reasonKey(item.failureCode)) })}
          </span>
        )}
      </button>
      <span className="flex shrink-0 gap-1 py-2 pr-2">
        <IconButton
          glyph="send"
          label={t('scheduled.sendNow')}
          aria-disabled={busy}
          onClick={() => {
            if (!busy) onSendNow(place);
          }}
        />
        <IconButton
          glyph="edit"
          label={t('scheduled.edit')}
          aria-disabled={busy}
          onClick={() => {
            if (!busy) onEdit(place);
          }}
        />
        <IconButton
          glyph="delete"
          label={t('scheduled.cancel')}
          aria-disabled={busy}
          onClick={() => {
            if (!busy) onCancel();
          }}
        />
      </span>
    </li>
  );
};

/** What the person can do with a scheduled message, each said in words when it cannot be done. */
const useScheduledActions = (): {
  readonly busy: ReadonlySet<string>;
  readonly sendNow: (item: ScheduledMessage, place: string) => void;
  readonly cancel: (item: ScheduledMessage) => void;
  readonly edit: (item: ScheduledMessage, place: string) => void;
} => {
  const { t } = useI18n();
  const api = useApi();
  const client = useQueryClient();
  const { show } = useToast();
  const { navigate } = useRoute();
  const { workspace } = useWorkspace();
  const { user } = useSession();
  const describe = useDescribeFailure();
  const given = useContext(ComposerPortsContext);
  const storage = useMemo(() => (given ?? browserPorts()).storage, [given]);
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const working = useRef(new Set<string>());
  const listKey = keys.scheduled(workspace.id, user.id);

  const without = (id: string): void => {
    client.setQueryData<ScheduledMessageList>(listKey, (held) =>
      held?.filter((item) => item.id !== id),
    );
  };
  const reread = (): void => {
    void client.invalidateQueries({ queryKey: listKey });
  };
  /** One at a time per message: a second press while the first is on its way is the same wish. */
  const exclusively = async (id: string, run: () => Promise<void>): Promise<void> => {
    if (working.current.has(id)) return;
    working.current.add(id);
    setBusy(new Set(working.current));
    try {
      await run();
    } finally {
      working.current.delete(id);
      setBusy(new Set(working.current));
    }
  };
  /** Cancels it; true when it is no longer there to be sent, and false after telling the person why not. */
  const cancelled = async (item: ScheduledMessage): Promise<boolean> => {
    try {
      await api.cancelScheduledMessage(item.channelId, item.id);
    } catch (failure) {
      // Gone already — cancelled on another device — is what was asked for.
      if (codeOf(failure) === 'SCHEDULED_MESSAGE_NOT_FOUND') return true;
      reread();
      show({
        message:
          codeOf(failure) === 'SCHEDULED_MESSAGE_SENT'
            ? t('scheduled.alreadySent')
            : describe(failure),
      });
      return false;
    }
    return true;
  };

  const restore = async (item: ScheduledMessage): Promise<void> => {
    try {
      await api.scheduleMessage(item.channelId, item.id, {
        content: item.content,
        ...(item.parentId === null ? {} : { parentId: item.parentId }),
        ...(item.attachments.length === 0
          ? {}
          : { attachmentIds: item.attachments.map((file) => file.id) }),
        sendAt: item.sendAt,
      });
    } catch {
      show({ message: t('scheduled.undoFailed') });
    }
    reread();
  };

  return {
    busy,
    sendNow: (item, place): void => {
      void exclusively(item.id, async () => {
        // Gone from the list at once: the server sends it, or says why not and it comes back.
        const before = client.getQueryData<ScheduledMessageList>(listKey);
        without(item.id);
        try {
          await api.sendScheduledMessage(item.channelId, item.id);
          show({ message: t('scheduled.sentNow', { place }) });
          void client.invalidateQueries({ queryKey: keys.sent(workspace.id, user.id) });
        } catch (failure) {
          const code = codeOf(failure);
          // Sent already — a second press, another device, or its own time came — is what was asked for.
          if (code === 'SCHEDULED_MESSAGE_SENT') {
            show({ message: t('scheduled.alreadySent') });
          } else {
            if (before !== undefined) client.setQueryData(listKey, before);
            const reason = reasonKey(code);
            show({
              message:
                reason === 'scheduled.reason.other'
                  ? describe(failure)
                  : t('scheduled.sendNowFailed', { reason: t(reason) }),
            });
          }
        }
        reread();
      });
    },
    cancel: (item): void => {
      void exclusively(item.id, async () => {
        if (!(await cancelled(item))) return;
        without(item.id);
        reread();
        show({
          message: t('scheduled.cancelled'),
          actionLabel: t('common.undo'),
          onAction: () => {
            void restore(item);
          },
        });
      });
    },
    edit: (item, place): void => {
      void exclusively(item.id, async () => {
        const parentId = item.parentId ?? undefined;
        const key = draftKey(user.id, item.channelId, parentId);
        const before = readDraft(storage, key);
        // The draft first: if this device cannot keep it, the message is still scheduled and nothing is lost.
        const words =
          before.trim() === '' ? item.content : `${before.trimEnd()}\n\n${item.content}`;
        if (!writeDraft(storage, key, words)) {
          show({ message: t('scheduled.draftFailed') });
          return;
        }
        if (!(await cancelled(item))) {
          writeDraft(storage, key, before);
          return;
        }
        without(item.id);
        reread();
        const files =
          item.attachments.length === 0
            ? ''
            : ` ${t('scheduled.editedFiles', { count: item.attachments.length })}`;
        show({ message: `${t('scheduled.edited', { place })}${files}` });
        navigate(
          parentId === undefined
            ? href('channel', { slug: workspace.slug, channelId: item.channelId })
            : threadHref(workspace.slug, item.channelId, parentId),
        );
      });
    },
  };
};

const Loading = ({ label }: { readonly label: string }): React.JSX.Element => (
  <LoadingStatus label={label} className="flex flex-col gap-4 py-2">
    {[0, 1, 2].map((row) => (
      <div key={row} className="flex flex-col gap-2">
        <Skeleton className="w-members" />
        <Skeleton className="w-feed" />
      </div>
    ))}
  </LoadingStatus>
);

export const ScheduledList = ({
  query,
  byId,
}: {
  readonly query: UseQueryResult<ScheduledMessageList>;
  readonly byId: ReadonlyMap<string, Channel>;
}): React.JSX.Element => {
  const { t } = useI18n();
  const { workspace } = useWorkspace();
  const { navigate } = useRoute();
  const actions = useScheduledActions();

  if (query.isPending) return <Loading label={t('scheduled.loading')} />;
  if (query.isError && query.data === undefined) {
    return (
      <ErrorState
        title={t('scheduled.loadFailed.title')}
        body={t('scheduled.loadFailed.body')}
        retryLabel={t('common.retry')}
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  }
  // A message in a channel the person can no longer see is not listed: there is nowhere to open it.
  const rows = query.data.filter((item) => byId.has(item.channelId));
  if (rows.length === 0) {
    return (
      <GlyphEmptyState
        glyph="schedule"
        tone="success"
        title={t('scheduled.empty.title')}
        body={t('scheduled.empty.body')}
      />
    );
  }
  return (
    <ListCard>
      {rows.map((item) => {
        const channel = byId.get(item.channelId);
        if (channel === undefined) return null;
        return (
          <Row
            key={item.id}
            item={item}
            channel={channel}
            busy={actions.busy.has(item.id)}
            onOpen={() => {
              navigate(
                item.parentId === null
                  ? href('channel', { slug: workspace.slug, channelId: item.channelId })
                  : threadHref(workspace.slug, item.channelId, item.parentId),
              );
            }}
            onSendNow={(place) => {
              actions.sendNow(item, place);
            }}
            onCancel={() => {
              actions.cancel(item);
            }}
            onEdit={(place) => {
              actions.edit(item, place);
            }}
          />
        );
      })}
    </ListCard>
  );
};
