/**
 * The states a sidebar section has besides "here is the list" (`UX.md` §8): loading,
 * failed, and empty.
 *
 * `EmptyState` and `ErrorState` are page-sized — a display-size heading — and a 240px
 * column cannot hold one without wrapping every word. These are their compact kin with
 * the same semantics: a skeleton is *rows of the right height* and one spoken sentence;
 * a failure is `role="alert"`, names what happened and offers Retry; an empty section
 * says what the section is for and offers the next action. Words are props, as there.
 */
import { Icon } from '../../components/icon';
import { Button } from '../../ui/button';
import { LoadingStatus, Skeleton } from '../../ui/skeleton';

export const SectionLoading = ({
  label,
  rows = 3,
}: {
  readonly label: string;
  readonly rows?: number;
}): React.JSX.Element => (
  <LoadingStatus label={label} className="flex flex-col gap-3 px-2 py-1">
    {Array.from({ length: rows }, (_, index) => (
      <Skeleton key={index} className={index % 2 === 0 ? 'w-members' : 'w-1/2'} />
    ))}
  </LoadingStatus>
);

export const SectionError = ({
  title,
  body,
  retryLabel,
  onRetry,
}: {
  readonly title: string;
  readonly body: string;
  readonly retryLabel: string;
  readonly onRetry: () => void;
}): React.JSX.Element => (
  <div role="alert" className="flex flex-col items-start gap-2 px-2 py-1">
    <p className="flex items-center gap-2 text-label text-danger-text">
      <Icon name="failed" size="sm" />
      {title}
    </p>
    <p className="text-caption text-ink-muted">{body}</p>
    <Button onClick={onRetry}>{retryLabel}</Button>
  </div>
);

export const SectionEmpty = ({
  title,
  body,
  action,
}: {
  readonly title: string;
  readonly body: string;
  readonly action?: React.ReactNode;
}): React.JSX.Element => (
  <div className="flex flex-col items-start gap-2 px-2 py-1">
    <p className="text-label text-ink">{title}</p>
    <p className="text-caption text-ink-muted">{body}</p>
    {action}
  </div>
);
