/**
 * About (D-248): the version this server runs, the newest release on GitHub and whether the first is the second,
 * the release notes of the running version, and where the source and the licence are.
 *
 * One read, `GET /api/releases/latest`: the version the server runs and the newest release it learned of, which it
 * answers *none* where it could not ask. The browser does not ask the public `GET /api/client` for the version:
 * that route is charged to the address with the sign-in traffic. Not knowing the newest one is a sentence of its
 * own, never an error: a server with no way out, or whose administrator turned the check off, is working as
 * configured. A request that failed is an error with Retry.
 */
import { useState } from 'react';
import { LICENCE, REPOSITORY_URL, type LatestRelease } from '@purlay/types';
import { Icon } from '../../../components/icon';
import { useLatestRelease } from '../../../data/queries';
import { useI18n } from '../../../i18n/i18n-provider';
import { Button, buttonStyle } from '../../../ui/button';
import { cn } from '../../../ui/cn';
import { LoadingStatus, Skeleton } from '../../../ui/skeleton';
import { ErrorState } from '../../../ui/states';
import { VisuallyHidden } from '../../../ui/visually-hidden';
import { ReleaseNotesDialog } from '../../about/release-notes-dialog';
import { useReleaseNotes } from '../../about/release-notes-source';
import { SettingsCard, SettingsPage, SettingsRow } from '../page';

/** Three numbers, as a version is written; anything else cannot be compared. */
const partsOf = (version: string): readonly number[] | null => {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  return match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3])];
};

/** Whether `latest` is a version after `running`; `null` when either is not three numbers. */
const isNewer = (latest: string, running: string): boolean | null => {
  const [a, b] = [partsOf(latest), partsOf(running)];
  if (a === null || b === null) return null;
  for (const [index, part] of a.entries()) {
    const other = b[index] ?? 0;
    if (part !== other) return part > other;
  }
  return false;
};

const ExternalAnchor = ({
  href,
  children,
}: {
  readonly href: string;
  readonly children: React.ReactNode;
}): React.JSX.Element => {
  const { t } = useI18n();
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 text-label text-accent-text underline"
    >
      {children}
      <Icon name="external" size="sm" />
      <VisuallyHidden>{` (${t('message.link.external')})`}</VisuallyHidden>
    </a>
  );
};

/** The sentence under the two versions, and the tone it is drawn in. */
const Status = ({
  running,
  latest,
}: {
  readonly running: string;
  readonly latest: LatestRelease | null;
}): React.JSX.Element => {
  const { t } = useI18n();
  const newer = latest === null ? null : isNewer(latest.version, running);
  const [words, tone] =
    latest === null || newer === null
      ? [t('about.status.unknown'), 'text-ink-muted']
      : newer
        ? [t('about.status.newer', { version: latest.version }), 'text-warning-text']
        : [t('about.status.current'), 'text-success-text'];
  return (
    <p role="status" className={cn('flex items-start gap-2 text-label font-normal', tone)}>
      <Icon name={newer === null ? 'info' : newer ? 'warning' : 'confirm'} />
      <span>{words}</span>
    </p>
  );
};

export const AboutPage = (): React.JSX.Element => {
  const { t, format } = useI18n();
  const release = useLatestRelease();
  const running = release.data?.current;
  const notes = useReleaseNotes(running).data ?? null;
  const [reading, setReading] = useState(false);

  const versions = ((): React.JSX.Element => {
    if (release.isError) {
      return (
        <ErrorState
          title={t('about.error.title')}
          body={t('about.error.body')}
          retryLabel={t('common.retry')}
          onRetry={() => {
            void release.refetch();
          }}
        />
      );
    }
    if (running === undefined) {
      return (
        <LoadingStatus label={t('common.loading')} className="px-6 py-5">
          <Skeleton />
        </LoadingStatus>
      );
    }
    const latest = release.data?.latest ?? null;
    return (
      <>
        <SettingsRow label={t('about.version.running')}>
          <span className="font-mono text-label text-ink">{running}</span>
        </SettingsRow>
        <SettingsRow label={t('about.version.latest')}>
          {latest === null ? (
            <span className="text-label text-ink-muted">{t('about.version.unknown')}</span>
          ) : (
            <div className="flex flex-col items-end gap-1 max-narrow:items-start">
              <span className="font-mono text-label text-ink">{latest.version}</span>
              <span className="text-caption text-ink-muted">
                {t('about.version.published', { date: format.date(latest.publishedAt) })}
              </span>
              <ExternalAnchor href={latest.url}>{t('about.version.open')}</ExternalAnchor>
            </div>
          )}
        </SettingsRow>
        <div className="border-t-hairline border-border-subtle px-6 py-4 max-narrow:px-4">
          <Status running={running} latest={latest} />
        </div>
        {notes !== null && (
          <SettingsRow label={t('about.whatsNew')} description={t('about.whatsNew.description')}>
            <Button
              onClick={() => {
                setReading(true);
              }}
            >
              {t('about.whatsNew')}
            </Button>
          </SettingsRow>
        )}
      </>
    );
  })();

  return (
    <SettingsPage title={t('about.title')} description={t('about.description')}>
      <SettingsCard title={t('about.version.title')}>{versions}</SettingsCard>
      <SettingsCard title={t('about.source.title')}>
        <SettingsRow label={t('about.source.licence')}>
          <span className="font-mono text-label text-ink">{LICENCE}</span>
        </SettingsRow>
        <SettingsRow label={t('about.source.repository')}>
          <a
            href={REPOSITORY_URL}
            target="_blank"
            rel="noopener noreferrer"
            className={buttonStyle('secondary')}
          >
            {REPOSITORY_URL.replace('https://', '')}
            <Icon name="external" size="sm" />
            <VisuallyHidden>{` (${t('message.link.external')})`}</VisuallyHidden>
          </a>
        </SettingsRow>
      </SettingsCard>
      {notes !== null && (
        <ReleaseNotesDialog notes={notes} open={reading} onOpenChange={setReading} />
      )}
    </SettingsPage>
  );
};
