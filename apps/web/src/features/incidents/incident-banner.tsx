/**
 * A channel's open incident, under its header (#487, D-137 §8): how bad, where it is, since when — and
 * the way to its panel. Nothing when none is open, or while it is read: the banner says what is
 * happening, and its panel says everything else, in all its states.
 */
import type { Channel } from '@purlay/types';
import { Icon } from '../../components/icon';
import { useI18n } from '../../i18n/i18n-provider';
import { Avatar } from '../../ui/avatar';
import { Button } from '../../ui/button';
import { VisuallyHidden } from '../../ui/visually-hidden';
import { useFeedPorts } from '../channel/feed-ports';
import { useNowMinute } from '../channel/now-minute';
import { useSidePanel } from '../channel/side-panel';
import { INCIDENT_PANEL_ID } from './incident-panel';
import { useIncident } from './use-incident';

export const IncidentBanner = ({
  channel,
}: {
  readonly channel: Channel;
}): React.JSX.Element | null => {
  const { t, format } = useI18n();
  const side = useSidePanel();
  const now = new Date(useNowMinute(useFeedPorts()));
  const read = useIncident(channel.id);
  const incident = read.data;
  if (read.isError && incident === undefined) {
    // Not knowing is said: a channel with a SEV1 open must not look calm because a read failed.
    return (
      <section
        aria-label={t('incident.title')}
        className="flex shrink-0 items-center gap-2 border-b-hairline border-border-subtle px-4 py-1 text-label text-ink-muted"
      >
        <Icon name="warning" />
        <span className="min-w-0 flex-1 truncate">{t('incident.unknown')}</span>
        <Button
          variant="ghost"
          onClick={() => {
            void read.refetch();
          }}
        >
          {t('common.retry')}
        </Button>
      </section>
    );
  }
  if (incident == null || incident.status === 'resolved') return null;
  const open = side.panel === 'incident';
  return (
    <section
      aria-label={t('incident.banner')}
      className="flex shrink-0 items-center gap-2 border-b-hairline border-border-subtle bg-danger-subtle px-4 py-1 text-label text-danger-text"
    >
      <Icon name="warning" />
      <span className="font-semibold">{t('incident.sev', { n: incident.severity })}</span>
      <span aria-hidden="true">·</span>
      <span>{t(`incident.${incident.status}`)}</span>
      <span aria-hidden="true">·</span>
      <time dateTime={incident.declaredAt} className="min-w-0 truncate font-mono">
        {t('incident.since', { when: format.time(incident.declaredAt, now) })}
      </time>
      {incident.responders.length > 0 && (
        <span className="flex shrink-0 items-center gap-1">
          {incident.responders.slice(0, 3).map((person) => (
            <Avatar
              key={person.id}
              name={person.displayName}
              username={person.username}
              size="sm"
            />
          ))}
          {incident.responders.length > 3 && (
            <span
              aria-hidden="true"
              className="font-mono"
            >{`+${String(incident.responders.length - 3)}`}</span>
          )}
          <VisuallyHidden>
            {t('incident.respondingCount', { count: incident.responders.length })}
          </VisuallyHidden>
        </span>
      )}
      <Button
        variant="ghost"
        className="ml-auto"
        data-panel-toggle="incident"
        aria-pressed={open}
        aria-controls={open ? INCIDENT_PANEL_ID : undefined}
        onClick={() => {
          if (open) side.close();
          else side.open('incident');
        }}
      >
        {t('incident.details')}
      </Button>
    </section>
  );
};
