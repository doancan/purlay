/**
 * A channel's incident, in the panel beside its conversation (#487, D-137, `UX.md` §2).
 *
 * Open, it is its severity and its status — each changed in place by anyone in the channel, painted
 * at once — then Resolve, asked first because it is once and for good; then what happened, newest
 * first. With none open, it is how to declare one, and when the last was resolved. Its states are the
 * panel's own (§8): loading, failed with Retry, none, open, resolved.
 */
import { useInfiniteQuery } from '@tanstack/react-query';
import type {
  Channel,
  Incident,
  IncidentSeverity,
  IncidentUpdate,
  IncidentUpdatePage,
} from '@purlay/types';
import { useEffect, useId, useRef, useState } from 'react';
import { useApi } from '../../data/api-provider';
import { useDescribeFailure } from '../../data/failure';
import { keys } from '../../data/keys';
import { useI18n } from '../../i18n/i18n-provider';
import { Button } from '../../ui/button';
import { LoadingStatus, Skeleton } from '../../ui/skeleton';
import { ErrorState } from '../../ui/states';
import { PanelEmpty, PanelFrame, StaleBanner, usePanelFocus } from '../channel/panel-frame';
import { useSidePanel } from '../channel/side-panel';
import { useIncident, useIncidentActions, type IncidentActions } from './use-incident';

export const INCIDENT_PANEL_ID = 'channel-incident';

const SEVERITIES: readonly IncidentSeverity[] = [1, 2, 3, 4];

/** Four choices, one pressed: a group of buttons, each saying which it is. */
const SeverityChoice = ({
  value,
  onChoose,
  disabled = false,
}: {
  readonly value: IncidentSeverity;
  readonly onChoose: (severity: IncidentSeverity) => void;
  readonly disabled?: boolean;
}): React.JSX.Element => {
  const { t } = useI18n();
  const labelId = useId();
  return (
    <div className="flex flex-col gap-1">
      <span id={labelId} className="text-caption text-ink-muted">
        {t('incident.severity')}
      </span>
      <div role="group" aria-labelledby={labelId} className="flex gap-1">
        {SEVERITIES.map((severity) => (
          <Button
            key={severity}
            variant={severity === value ? 'primary' : 'secondary'}
            aria-pressed={severity === value}
            aria-label={t('incident.sevOf', { n: severity })}
            disabled={disabled}
            onClick={() => {
              onChoose(severity);
            }}
          >
            {t('incident.sev', { n: severity })}
          </Button>
        ))}
      </div>
    </div>
  );
};

const Declare = ({
  actions,
  onDeclared,
}: {
  readonly actions: IncidentActions;
  /** The form goes as the incident comes: focus is given somewhere, never to nothing. */
  readonly onDeclared: () => void;
}): React.JSX.Element => {
  const { t } = useI18n();
  const [severity, setSeverity] = useState<IncidentSeverity>(2);
  return (
    <div className="flex flex-col gap-3 px-4 pb-4">
      <SeverityChoice value={severity} onChoose={setSeverity} />
      <Button
        variant="danger"
        glyph="warning"
        busy={actions.declaring}
        onClick={(event) => {
          const button = event.currentTarget;
          void actions.declare(severity).then((declared) => {
            // Declared, the form goes: the heading. Refused, the button was disabled while busy and
            // lost focus: back to it, to try again.
            if (declared) onDeclared();
            else button.focus();
          });
        }}
      >
        {t('incident.declare')}
      </Button>
    </div>
  );
};

/** Status and severity, changed in place; Resolve asks first. */
const Controls = ({
  incident,
  actions,
  onResolved,
}: {
  readonly incident: Incident;
  readonly actions: IncidentActions;
  readonly onResolved: () => void;
}): React.JSX.Element => {
  const { t } = useI18n();
  const [asking, setAsking] = useState(false);
  const questionId = useId();
  const statusId = useId();
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (asking) box.current?.querySelector<HTMLElement>('[data-answer="cancel"]')?.focus();
  }, [asking]);
  return (
    <div ref={box} className="flex flex-col gap-3 px-4 py-3">
      <SeverityChoice
        value={incident.severity}
        onChoose={(severity) => {
          void actions.change(incident, { severity });
        }}
      />
      <div className="flex flex-col gap-1">
        <span id={statusId} className="text-caption text-ink-muted">
          {t('incident.status')}
        </span>
        <div role="group" aria-labelledby={statusId} className="flex flex-wrap gap-1">
          {(['investigating', 'mitigating'] as const).map((status) => (
            <Button
              key={status}
              variant={incident.status === status ? 'primary' : 'secondary'}
              aria-pressed={incident.status === status}
              onClick={() => {
                void actions.change(incident, { status });
              }}
            >
              {t(`incident.${status}`)}
            </Button>
          ))}
          {!asking && (
            <Button
              variant="dangerQuiet"
              data-ask="resolve"
              onClick={() => {
                setAsking(true);
              }}
            >
              {t('incident.resolve')}
            </Button>
          )}
        </div>
      </div>
      {asking && (
        <div role="group" aria-labelledby={questionId} className="flex flex-col gap-2">
          <p id={questionId} className="text-label text-ink">
            {t('incident.resolveAsk')}
          </p>
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              data-answer="cancel"
              onClick={() => {
                setAsking(false);
                // Back where the person was, never to nothing.
                requestAnimationFrame(() => {
                  box.current?.querySelector<HTMLElement>('[data-ask="resolve"]')?.focus();
                });
              }}
            >
              {t('common.cancel')}
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setAsking(false);
                onResolved();
                void actions.change(incident, { status: 'resolved' });
              }}
            >
              {t('incident.resolveConfirm')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
};

/** What an entry says: who did what, to whom. Exhaustive: a new kind is a compile error here. */
const sentenceOf = (
  update: IncidentUpdate,
  name: string,
  t: ReturnType<typeof useI18n>['t'],
): string => {
  const { change } = update;
  switch (change.kind) {
    case 'declared':
      return t('incident.declared', { name, n: change.severity });
    case 'status':
      return change.to === 'resolved'
        ? t('incident.resolvedBy', { name })
        : t('incident.moved', { name, status: t(`incident.${change.to}`) });
    case 'severity':
      return t(change.to < change.from ? 'incident.worse' : 'incident.better', {
        name,
        from: change.from,
        to: change.to,
      });
    case 'responder_added':
    case 'responder_removed': {
      const added = change.kind === 'responder_added';
      // Themselves: "is responding", not "brought themselves in".
      if (change.user !== null && change.user.id === update.actor?.id) {
        return t(added ? 'incident.selfIn' : 'incident.selfOff', { name });
      }
      const who = change.user?.displayName ?? t('incident.someone');
      return t(added ? 'incident.broughtIn' : 'incident.tookOff', { name, who });
    }
  }
};

/** One entry of the timeline, said as a sentence: who did what. */
const Entry = ({ update }: { readonly update: IncidentUpdate }): React.JSX.Element => {
  const { t, format } = useI18n();
  const name = update.actor?.displayName ?? t('incident.someone');
  const said = sentenceOf(update, name, t);
  return (
    <li className="flex flex-col gap-1 border-t-hairline border-border-subtle py-2">
      <span className="text-body text-ink">{said}</span>
      <time dateTime={update.at} className="font-mono text-caption text-ink-muted">
        {format.absolute(update.at)}
      </time>
    </li>
  );
};

const Timeline = ({
  channelId,
  incidentId,
}: {
  readonly channelId: string;
  readonly incidentId: string;
}): React.JSX.Element => {
  const { t } = useI18n();
  const api = useApi();
  const describe = useDescribeFailure();
  const headingId = useId();
  const updates = useInfiniteQuery({
    queryKey: [...keys.incident(channelId), 'updates', incidentId],
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page: IncidentUpdatePage): string | undefined =>
      page.nextCursor ?? undefined,
    queryFn: async ({ pageParam, signal }) =>
      await api.incidentUpdates(channelId, incidentId, pageParam, signal),
  });
  const all = updates.data?.pages.flatMap((page) => page.data) ?? [];
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-1 px-4 pb-4">
      <h3 id={headingId} className="text-label font-semibold text-ink">
        {t('incident.timeline')}
      </h3>
      {updates.isError && updates.data === undefined ? (
        <div role="alert" className="flex items-center gap-2 text-label text-danger-text">
          {`${t('incident.timelineFailed')} ${describe(updates.error)}`}
          <Button
            variant="ghost"
            onClick={() => {
              void updates.refetch();
            }}
          >
            {t('common.retry')}
          </Button>
        </div>
      ) : updates.data === undefined ? (
        <LoadingStatus label={t('incident.loading')} className="flex flex-col gap-2">
          <Skeleton className="w-sidebar" />
        </LoadingStatus>
      ) : (
        <ul className="flex flex-col">
          {all.map((update) => (
            <Entry key={update.id} update={update} />
          ))}
        </ul>
      )}
      {updates.isFetchNextPageError && (
        <p role="alert" className="text-label text-danger-text">
          {`${t('incident.timelineFailed')} ${describe(updates.error)}`}
        </p>
      )}
      {updates.hasNextPage && (
        <Button
          variant="ghost"
          busy={updates.isFetchingNextPage}
          onClick={() => {
            void updates.fetchNextPage();
          }}
        >
          {t('incident.older')}
        </Button>
      )}
    </section>
  );
};

const IncidentPanelView = ({
  channel,
  channelLabel,
}: {
  readonly channel: Channel;
  readonly channelLabel: string;
}): React.JSX.Element => {
  const { t, format } = useI18n();
  const incident = useIncident(channel.id);
  const actions = useIncidentActions(channel.id);
  const focus = usePanelFocus(
    incident.isFetching,
    Math.max(incident.dataUpdatedAt, incident.errorUpdatedAt),
  );
  // Seeing a public channel is not being in it: its incident is read, never changed (D-137 §2).
  const member = channel.state !== null;
  const current = incident.data;
  // What the panel shows changed under the person — somebody else resolved or declared, a read
  // failed — and the control they were on went with it: their place is the heading, never nothing.
  const kind = incident.isPending
    ? 'loading'
    : current === undefined
      ? 'failed'
      : current === null || current.status === 'resolved'
        ? 'none'
        : 'open';
  useEffect(() => {
    if (document.activeElement === document.body) focus.headingRef.current?.focus();
  }, [kind, focus.headingRef]);

  let body: React.JSX.Element;
  if (incident.isPending) {
    body = (
      <LoadingStatus label={t('incident.loading')} className="flex flex-col gap-3 p-4">
        <Skeleton className="w-members" />
        <Skeleton className="w-sidebar" />
      </LoadingStatus>
    );
  } else if (current === undefined) {
    body = (
      <ErrorState
        title={t('incident.error.title')}
        body={t('incident.error.body')}
        retryLabel={t('common.retry')}
        onRetry={() => {
          focus.answering();
          void incident.refetch();
        }}
      />
    );
  } else if (current === null || current.status === 'resolved') {
    body = (
      <>
        <PanelEmpty
          glyph="warning"
          title={t('incident.none.title')}
          body={t('incident.none.body')}
        />
        {current !== null && (
          <p className="px-4 pb-3 text-center text-label text-ink-muted">
            {t('incident.resolvedLast', { when: format.absolute(current.resolvedAt) })}
          </p>
        )}
        {member && (
          <Declare actions={actions} onDeclared={() => focus.headingRef.current?.focus()} />
        )}
        {current !== null && <Timeline channelId={channel.id} incidentId={current.id} />}
      </>
    );
  } else {
    body = (
      <>
        {member && (
          <Controls
            incident={current}
            actions={actions}
            onResolved={() => focus.headingRef.current?.focus()}
          />
        )}
        <Timeline channelId={channel.id} incidentId={current.id} />
      </>
    );
  }

  return (
    <PanelFrame
      id={INCIDENT_PANEL_ID}
      title={t('incident.title')}
      channelLabel={channelLabel}
      closeLabel={t('incident.close')}
      focus={focus}
    >
      {incident.isRefetchError && (
        <StaleBanner
          message={t('incident.staleFailed')}
          onRetry={() => {
            focus.answering();
            void incident.refetch();
          }}
        />
      )}
      {body}
    </PanelFrame>
  );
};

/** The channel's incident panel, when it is the one open. */
export const IncidentPanel = (props: {
  readonly channel: Channel;
  readonly channelLabel: string;
}): React.JSX.Element | null => {
  const { panel } = useSidePanel();
  return panel === 'incident' ? <IncidentPanelView {...props} /> : null;
};
