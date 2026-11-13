/** Shared feedback; secrets stay in mounted component state, never query keys or storage. */
import { useEffect, useRef, useState } from 'react';
import { useDescribeFailure } from '../../../data/failure';
import { isLibraryFailure } from '../../../data/errors';
import { useI18n } from '../../../i18n/i18n-provider';
import { Button } from '../../../ui/button';
import { LoadingStatus, Skeleton } from '../../../ui/skeleton';
import { useContentPorts } from '../../content/content-ports';
import { useToast } from '../../../ui/toast';
import { systemClock } from '../../../system-clock';
import type { Clock } from '../../../realtime/clock';

interface SecurityTask {
  readonly current: () => boolean;
  readonly busy: boolean;
  readonly problem: string | null;
  readonly setProblem: (text: string | null) => void;
  readonly run: <T>(
    work: () => Promise<T>,
    accept: (result: T) => void | Promise<void>,
  ) => Promise<void>;
}

export const useSecurityTask = (refused?: (failure: unknown) => void): SecurityTask => {
  const alive = useRef(true);
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const describe = useDescribeFailure();
  const { t } = useI18n();
  useEffect(() => {
    alive.current = true;
    return (): void => {
      alive.current = false;
    };
  }, []);
  const run = async <T,>(
    work: () => Promise<T>,
    accept: (result: T) => void | Promise<void>,
  ): Promise<void> => {
    const current = (): boolean => alive.current;
    if (!current() || pending.current) return;
    pending.current = true;
    setBusy(true);
    setProblem(null);
    try {
      const result = await work();
      if (current()) await accept(result);
    } catch (error) {
      if (current()) {
        refused?.(error);
        setProblem(
          isLibraryFailure(error)
            ? t(
                error.code === 'NETWORK'
                  ? 'failure.network'
                  : error.status === 429
                    ? 'failure.workspaceMfaLocked'
                    : error.code === 'MALFORMED' || error.status >= 500
                      ? 'failure.generic'
                      : 'failure.workspaceMfaInvalid',
              )
            : describe(error),
        );
      }
    } finally {
      pending.current = false;
      if (current()) setBusy(false);
    }
  };
  return { current: () => alive.current, busy, problem, setProblem, run };
};

export const SecurityProblem = ({
  text,
}: {
  readonly text: string | null;
}): React.JSX.Element | null =>
  text === null ? null : (
    <p role="alert" className="text-body text-danger-text">
      {text}
    </p>
  );

export const SecurityLoading = ({
  failed,
  retry,
}: {
  readonly failed: boolean;
  readonly retry: () => void;
}): React.JSX.Element => {
  const { t } = useI18n();
  return failed ? (
    <div className="flex flex-wrap items-center gap-3 px-6 py-5 max-narrow:px-4">
      <p role="alert" className="min-w-0 flex-1 text-body text-ink-muted">
        {t('security.loadFailed')}
      </p>
      <Button onClick={retry}>{t('common.retry')}</Button>
    </div>
  ) : (
    <LoadingStatus
      label={t('common.loading')}
      className="flex flex-col gap-3 px-6 py-5 max-narrow:px-4"
    >
      <Skeleton />
      <Skeleton />
    </LoadingStatus>
  );
};

export const SecretValue = ({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}): React.JSX.Element => {
  const { t } = useI18n();
  const { copy } = useContentPorts();
  const { show } = useToast();
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <span className="text-label text-ink">{label}</span>
      <code className="min-w-0 select-all whitespace-pre-wrap break-all rounded-md border-hairline border-border-subtle bg-surface-050 p-3 font-mono text-body text-ink">
        {value}
      </code>
      <div>
        <Button
          glyph="copy"
          onClick={() => {
            void copy(value).then(
              () => {
                show({ message: t('common.copied') });
              },
              () => {
                show({ message: t('failure.copy') });
              },
            );
          }}
        >
          {t('common.copy')}
        </Button>
      </div>
    </div>
  );
};

export const useExpired = (expiresAt: string, clock: Clock = systemClock): boolean => {
  const [expired, setExpired] = useState(() => Date.parse(expiresAt) <= clock.now().getTime());
  useEffect(() => {
    const remaining = Date.parse(expiresAt) - clock.now().getTime();
    setExpired(remaining <= 0);
    if (remaining <= 0) return;
    const timer = setTimeout(() => {
      setExpired(true);
    }, remaining);
    return (): void => {
      clearTimeout(timer);
    };
  }, [expiresAt, clock]);
  return expired;
};
