/**
 * A channel's pinned messages, in the panel beside its conversation (D-130, `UX.md` §2).
 *
 * Newest pin first, each with who said it and when, its words, and who pinned it; a reply opens its
 * thread here, in the panel's place, and a member lets a pin go from its row. What is listed is the
 * server's pins with what has been asked laid over them (`use-pin.ts`), so the row goes as Unpin is
 * pressed and comes back if it is refused. The states are the panel's own (§8): loading, failed
 * with Retry, a list that could not be brought up to date, and empty.
 *
 * **Focus stays in the panel**: a row that goes with its Unpin hands focus to the next row's Unpin,
 * or the one before, or the heading — never to nothing, where Esc would not reach the panel.
 */
import type { PinnedMessage } from '@purlay/types';
import { Icon } from '../../components/icon';
import { useI18n } from '../../i18n/i18n-provider';
import { Avatar } from '../../ui/avatar';
import { Button } from '../../ui/button';
import { LoadingStatus, Skeleton } from '../../ui/skeleton';
import { ErrorState } from '../../ui/states';
import { useFeedPorts } from '../channel/feed-ports';
import { useNowMinute } from '../channel/now-minute';
import {
  PanelEmpty,
  PanelFrame,
  StaleBanner,
  usePanelFocus,
  type PanelFocus,
} from '../channel/panel-frame';
import { useSidePanel } from '../channel/side-panel';
import { useThreads } from '../threads/thread-context';
import { usePin, useShownPins } from './use-pin';

export const PINS_PANEL_ID = 'channel-pins';

/** Where focus goes when a row's Unpin takes the row away: the next Unpin, the one before, or the heading. */
const focusAfter = (button: HTMLElement, focus: PanelFocus): void => {
  const all = Array.from(
    focus.panelRef.current?.querySelectorAll<HTMLElement>('[data-unpin]') ?? [],
  );
  const at = all.indexOf(button);
  const next = all[at + 1] ?? all[at - 1];
  if (next === undefined) focus.headingRef.current?.focus();
  else next.focus();
};

const PinRow = ({
  pin,
  now,
  focus,
}: {
  readonly pin: PinnedMessage;
  readonly now: Date;
  readonly focus: PanelFocus;
}): React.JSX.Element => {
  const { t, format } = useI18n();
  const threads = useThreads();
  const { canPin, toggle } = usePin(pin.message);
  const { message } = pin;
  const parentId = message.parentId;
  const name = message.sender.displayName;
  return (
    <li className="flex flex-col gap-2 rounded-lg px-2 py-2 hover:bg-surface-200">
      <div className="flex min-w-0 items-start gap-2">
        <Avatar name={name} username={message.sender.username} size="sm" />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex min-w-0 items-center gap-1 text-caption text-ink-muted">
            <span className="truncate font-semibold text-ink">{name}</span>
            <span aria-hidden="true">·</span>
            <time dateTime={message.createdAt} className="shrink-0 font-mono">
              {format.time(message.createdAt, now)}
            </time>
          </span>
          <p className="line-clamp-3 whitespace-pre-wrap break-words text-body text-ink">
            {message.content}
          </p>
          <span data-pinned-by="" className="flex items-center gap-1 text-caption text-ink-subtle">
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
              aria-label={t('pins.threadOf', { name })}
              onClick={() => {
                threads.open(parentId);
              }}
            >
              {t('pins.inThread')}
            </Button>
          )}
          {canPin && (
            <Button
              variant="ghost"
              glyph="unpin"
              data-unpin=""
              aria-label={t('pins.unpinOf', { name })}
              onClick={(event) => {
                focusAfter(event.currentTarget, focus);
                toggle();
              }}
            >
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
  const { query, pins } = useShownPins(channelId);
  const now = new Date(useNowMinute(useFeedPorts()));
  const focus = usePanelFocus(
    query.isFetching,
    Math.max(query.dataUpdatedAt, query.errorUpdatedAt),
  );
  const readAgain = (): void => {
    focus.answering();
    void query.refetch();
  };

  let body: React.JSX.Element;
  if (query.isPending && pins.length === 0) {
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
    body = <PanelEmpty glyph="pin" title={t('pins.empty.title')} body={t('pins.empty.body')} />;
  } else {
    body = (
      <ul aria-labelledby={focus.headingId} className="flex flex-col gap-1 px-2 py-2">
        {pins.map((pin) => (
          <PinRow key={pin.message.id} pin={pin} now={now} focus={focus} />
        ))}
      </ul>
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
      {query.isRefetchError && <StaleBanner message={t('pins.staleFailed')} onRetry={readAgain} />}
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
