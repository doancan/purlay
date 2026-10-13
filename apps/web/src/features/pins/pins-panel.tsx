/**
 * A channel's pinned messages, in the panel beside its conversation (D-130, `UX.md` §2).
 *
 * Newest pin first, each with who said it and when, its words, and who pinned it; a reply opens its
 * thread here, in the panel's place, and a member lets a pin go from its row. The list is the one
 * that marks pinned messages in the feed (`use-pin.ts`), kept current by `PINS_UPDATED`; the states
 * are the panel's own (§8): loading, failed with Retry, a list that could not be brought up to date,
 * and empty.
 */
import type { PinnedMessage } from '@purlay/types';
import { Icon } from '../../components/icon';
import { useChannelPins } from '../../data/queries';
import { useI18n } from '../../i18n/i18n-provider';
import { Avatar } from '../../ui/avatar';
import { Button } from '../../ui/button';
import { LoadingStatus, Skeleton } from '../../ui/skeleton';
import { ErrorState } from '../../ui/states';
import { useFeedPorts } from '../channel/feed-ports';
import { useNowMinute } from '../channel/now-minute';
import { PanelFrame, usePanelFocus } from '../channel/panel-frame';
import { useSidePanel } from '../channel/side-panel';
import { useThreads } from '../threads/thread-context';
import { usePin } from './use-pin';

export const PINS_PANEL_ID = 'channel-pins';

const PinRow = ({
  pin,
  now,
}: {
  readonly pin: PinnedMessage;
  readonly now: Date;
}): React.JSX.Element => {
  const { t, format } = useI18n();
  const threads = useThreads();
  const { canPin, toggle } = usePin(pin.message);
  const { message } = pin;
  const parentId = message.parentId;
  return (
    <li className="flex flex-col gap-2 rounded-lg px-2 py-2 hover:bg-surface-200">
      <div className="flex min-w-0 items-start gap-2">
        <Avatar name={message.sender.displayName} username={message.sender.username} size="sm" />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex min-w-0 items-center gap-1 text-caption text-ink-muted">
            <span className="truncate font-semibold text-ink">{message.sender.displayName}</span>
            <span aria-hidden="true">·</span>
            <time dateTime={message.createdAt} className="shrink-0 font-mono">
              {format.time(message.createdAt, now)}
            </time>
          </span>
          <p className="line-clamp-3 whitespace-pre-wrap break-words text-body text-ink">
            {message.content}
          </p>
          <span className="flex items-center gap-1 text-caption text-ink-subtle">
            <Icon name="pin" size="sm" />
            {pin.pinnedBy === null
              ? t('pins.byNobody')
              : t('pins.by', { name: pin.pinnedBy.displayName })}
          </span>
        </div>
      </div>
      {(parentId !== null || canPin) && (
        <div className="flex flex-wrap gap-2 pl-8">
          {parentId !== null && (
            <Button
              variant="ghost"
              onClick={() => {
                threads.open(parentId);
              }}
            >
              {t('pins.inThread')}
            </Button>
          )}
          {canPin && (
            <Button variant="ghost" glyph="unpin" onClick={toggle}>
              {t('pins.unpin')}
            </Button>
          )}
        </div>
      )}
    </li>
  );
};

const PinsPanelView = ({
  channelId,
  channelLabel,
}: {
  readonly channelId: string;
  readonly channelLabel: string;
}): React.JSX.Element => {
  const { t } = useI18n();
  const query = useChannelPins(channelId);
  const now = new Date(useNowMinute(useFeedPorts()));
  const focus = usePanelFocus(
    query.isFetching,
    Math.max(query.dataUpdatedAt, query.errorUpdatedAt),
  );
  const readAgain = (): void => {
    focus.answering();
    void query.refetch();
  };
  const pins = query.data ?? [];

  let body: React.JSX.Element;
  if (query.isPending) {
    body = (
      <LoadingStatus label={t('pins.loading')} className="flex flex-col gap-3 p-4">
        {[0, 1, 2].map((row) => (
          <div key={row} className="flex flex-col gap-2">
            <Skeleton className="w-members" />
            <Skeleton className="w-sidebar" />
          </div>
        ))}
      </LoadingStatus>
    );
  } else if (query.isError && query.data === undefined) {
    body = (
      <ErrorState
        title={t('pins.error.title')}
        body={t('pins.error.body')}
        retryLabel={t('common.retry')}
        onRetry={readAgain}
      />
    );
  } else if (pins.length === 0) {
    body = (
      <section className="flex flex-col items-center gap-3 px-4 py-8 text-center">
        <span
          aria-hidden="true"
          className="inline-flex size-avatar-lg items-center justify-center rounded-lg bg-accent-subtle text-accent-text"
        >
          <Icon name="pin" size="lg" />
        </span>
        <h3 className="text-title text-ink">{t('pins.empty.title')}</h3>
        <p className="text-body text-ink-muted">{t('pins.empty.body')}</p>
      </section>
    );
  } else {
    body = (
      <div className="flex flex-col gap-3 px-2 py-2">
        {query.isRefetchError && (
          <p role="alert" className="flex items-center gap-2 px-2 text-label text-danger-text">
            <Icon name="failed" size="sm" />
            {t('pins.staleFailed')}
            <span aria-hidden="true">·</span>
            <button type="button" className="underline" onClick={readAgain}>
              {t('common.retry')}
            </button>
          </p>
        )}
        <ul aria-labelledby={focus.headingId} className="flex flex-col gap-1">
          {pins.map((pin) => (
            <PinRow key={pin.message.id} pin={pin} now={now} />
          ))}
        </ul>
      </div>
    );
  }

  return (
    <PanelFrame
      id={PINS_PANEL_ID}
      title={t('pins.title')}
      channelLabel={channelLabel}
      closeLabel={t('pins.close')}
      focus={focus}
    >
      {body}
    </PanelFrame>
  );
};

/** The channel's pinned messages panel, when it is the one open. */
export const PinsPanel = (props: {
  readonly channelId: string;
  readonly channelLabel: string;
}): React.JSX.Element | null => {
  const { panel } = useSidePanel();
  return panel === 'pins' ? <PinsPanelView {...props} /> : null;
};
