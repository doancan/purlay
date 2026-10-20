/**
 * The states a sidebar section has besides "here is the list" (`UX.md` §8): loading,
 * failed, and empty.
 *
 * `EmptyState` and `ErrorState` are page-sized — a display-size heading — and a 240px
 * column cannot hold one without wrapping every word. These are their compact kin with
 * the same semantics: a skeleton is *rows of the right height* and one spoken sentence;
 * a failure is `role="alert"`, names what happened and offers Retry; an empty section
 * says what the section is for and offers the next action. Words are props, as there.
 *
 * In the sidebar each is inset as a row's words are; `flush` drops the inset where there are no
 * rows to line up with — a dialog, whose own title they then sit under.
 */
import { Icon } from '../../components/icon';
import { Button } from '../../ui/button';
import { cn } from '../../ui/cn';
import { LoadingStatus, Skeleton } from '../../ui/skeleton';

/** As a row's words in the sidebar, or at the edge of a dialog. */
const edge = (flush: boolean): string => (flush ? 'py-1' : 'px-2 py-1');

export const SectionLoading = ({
  label,
  rows = 3,
  flush = false,
}: {
  readonly label: string;
  readonly rows?: number;
  readonly flush?: boolean;
}): React.JSX.Element => (
  <LoadingStatus label={label} className={cn('flex flex-col gap-3', edge(flush))}>
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
  flush = false,
}: {
  readonly title: string;
  readonly body: string;
  readonly retryLabel: string;
  readonly onRetry: () => void;
  readonly flush?: boolean;
}): React.JSX.Element => (
  <div role="alert" className={cn('flex flex-col items-start gap-2', edge(flush))}>
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
  flush = false,
}: {
  readonly title: string;
  readonly body: string;
  readonly action?: React.ReactNode;
  readonly flush?: boolean;
}): React.JSX.Element => (
  <div className={cn('flex flex-col items-start gap-2', edge(flush))}>
    <p className="text-label text-ink">{title}</p>
    <p className="text-caption text-ink-muted">{body}</p>
    {action}
  </div>
);
