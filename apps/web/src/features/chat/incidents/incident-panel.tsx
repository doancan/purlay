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
import { useApi } from '../../../data/api-provider';
import { useDescribeFailure } from '../../../data/failure';
import { keys } from '../../../data/keys';
import { useI18n } from '../../../i18n/i18n-provider';
import { Button } from '../../../ui/button';
import { cn } from '../../../ui/cn';
import { LoadingStatus, Skeleton } from '../../../ui/skeleton';
import { ListFilter } from '../../../ui/list-column';
import { ErrorState } from '../../../ui/states';
import { PanelEmpty, PanelFrame, StaleBanner, usePanelFocus } from '../channel/panel-frame';
import { useSidePanel } from '../channel/side-panel';
import { Responders } from './responders';
import { headingClasses, sectionClasses } from './section';
import { WriteUp } from './writeup';
import { useIncident, useIncidentActions, type IncidentActions } from './use-incident';

import { INCIDENT_PANEL_ID } from './panel-id';

const SEVERITIES: readonly IncidentSeverity[] = [1, 2, 3, 4];

/**
 * Four choices, one pressed: the segmented control the product's other either-or choices are, each
 * named by what it shows — SEV1 — inside the group that says what SEV is (WCAG 2.5.3). The name above
 * is the group's own label, said once.
 */
const SeverityChoice = ({
  value,
  onChoose,
}: {
  readonly value: IncidentSeverity;
  readonly onChoose: (severity: IncidentSeverity) => void;
}): React.JSX.Element => {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-2">
      <span aria-hidden="true" className={headingClasses}>
        {t('incident.severity')}
      </span>
      <ListFilter
        label={t('incident.severity')}
        value={String(value)}
        choices={SEVERITIES.map((severity) => ({
          value: String(severity),
          label: t('incident.sev', { n: severity }),
        }))}
        onChange={(chosen) => {
          const severity = SEVERITIES.find((candidate) => String(candidate) === chosen);
          if (severity !== undefined) onChoose(severity);
        }}
      />
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
    <div className="flex flex-col gap-4 px-4 pb-4">
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
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (asking) box.current?.querySelector<HTMLElement>('[data-answer="cancel"]')?.focus();
  }, [asking]);
  return (
    <div ref={box} className={cn(sectionClasses, 'gap-4')}>
      <SeverityChoice
        value={incident.severity}
        onChoose={(severity) => {
          void actions.change(incident, { severity });
        }}
      />
      <div className="flex flex-col gap-2">
        <span aria-hidden="true" className={headingClasses}>
          {t('incident.status')}
        </span>
        {/* Where it stands, then the way out of it: Resolve is apart, as it is no step back. */}
        <div className="flex flex-wrap gap-2 max-narrow:flex-col">
          <ListFilter
            label={t('incident.status')}
            value={incident.status}
            choices={(['investigating', 'mitigating'] as const).map((status) => ({
              value: status,
              label: t(`incident.${status}`),
            }))}
            onChange={(status) => {
              void actions.change(incident, { status });
            }}
          />
          {!asking && (
            <Button
              variant="dangerQuiet"
              data-ask="resolve"
              className="self-center max-narrow:self-start"
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
        <div
          role="group"
          aria-labelledby={questionId}
          className="flex flex-col gap-3 rounded-lg border-hairline border-border-subtle bg-surface-050 p-3"
        >
          <p id={questionId} className="text-body text-ink">
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
    case 'runbook':
      return change.url === null
        ? t('incident.runbookCleared', { name })
        : t('incident.runbookSet', { name });
    case 'postmortem':
      return t('incident.postmortemSaved', { name });
  }
};

/** One entry of the timeline, said as a sentence: who did what. */
const Entry = ({ update }: { readonly update: IncidentUpdate }): React.JSX.Element => {
  const { t, format } = useI18n();
  const name = update.actor?.displayName ?? t('incident.someone');
  const said = sentenceOf(update, name, t);
  return (
    <li className="flex flex-col gap-1 py-2 first:pt-0 not-first:border-t-hairline border-border-subtle">
      <span className="text-body text-ink">{said}</span>
      <time dateTime={update.at} className="font-mono text-caption text-ink-subtle">
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
    <section aria-labelledby={headingId} className={sectionClasses}>
      <h3 id={headingId} className={headingClasses}>
        {t('incident.timeline')}
      </h3>
      {updates.isError && updates.data === undefined ? (
        <div role="alert" className="flex items-center gap-2 text-label text-danger-text">
          {`${t('incident.timelineFailed')} ${describe(updates.error)}`}
          <Button
            variant="ghost"
            aria-label={t('incident.retryTimeline')}
            onClick={() => {
              void updates.refetch();
            }}
          >
            {t('common.retry')}
          </Button>
        </div>
      ) : updates.data === undefined ? (
        <LoadingStatus label={t('incident.loading')} className="flex flex-col gap-4">
          {[0, 1].map((entry) => (
            <div key={entry} className="flex flex-col gap-2">
              <Skeleton className="w-3/4" />
              <Skeleton className="w-1/4" />
            </div>
          ))}
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
          variant="secondary"
          className="self-start"
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
      <LoadingStatus label={t('incident.loading')} className="flex flex-col gap-6 p-4">
        {/* The shape of what lands: a name above its choice, twice. */}
        {[0, 1].map((field) => (
          <div key={field} className="flex flex-col gap-2">
            <Skeleton className="w-1/4" />
            <Skeleton className="w-3/4" />
          </div>
        ))}
      </LoadingStatus>
    );
  } else if (current === undefined) {
    body = (
      // Inset as the panel's rows are: unframed, the failure starts where their words do, not at the panel's edge.
      <div className="px-4">
        <ErrorState
          title={t('incident.error.title')}
          body={t('incident.error.body')}
          retryLabel={t('common.retry')}
          onRetry={() => {
            focus.answering();
            void incident.refetch();
          }}
        />
      </div>
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
        {current !== null && (
          <>
            <Responders
              channelId={channel.id}
              incident={current}
              actions={actions}
              member={member}
            />
            <WriteUp incident={current} actions={actions} member={member} />
            <Timeline channelId={channel.id} incidentId={current.id} />
          </>
        )}
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
        <Responders channelId={channel.id} incident={current} actions={actions} member={member} />
        <WriteUp incident={current} actions={actions} member={member} />
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
      {/* Its own box: the first section counts from here, so no hairline is drawn under the banner. */}
      <div>{body}</div>
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
