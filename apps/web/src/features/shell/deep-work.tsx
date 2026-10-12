/**
 * Deep Work in the client (D-15, D-108): the server keeps the state and holds back what would
 * interrupt; here the person starts and ends it, sees until when, and the badges keep quiet.
 *
 * - `Cmd/Ctrl+Shift+D` (`UX.md` §7) starts it for an hour, or ends it.
 * - While it lasts a quiet bar says until when, with End (`UX.md` §8: a mode you can forget you are
 *   in is a mode that loses you messages). The mention badges in the sidebar are not drawn; the
 *   counts are still kept, so they are all there when it ends.
 * - It ends by itself at its instant: a timer set for it, and the clock compared when drawn.
 *
 * Painted first: the session's membership changes at once, and a refusal puts it back and says why.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { MeResponse, SetDeepWorkRequest } from '@purlay/types';
import { Icon } from '../../components/icon';
import { useApi } from '../../data/api-provider';
import { useDescribeFailure } from '../../data/failure';
import { keys } from '../../data/keys';
import { useI18n } from '../../i18n/i18n-provider';
import { RealtimePortsContext } from '../../realtime/realtime-provider';
import { browserSchedule } from '../../realtime/socket';
import { systemClock } from '../../system-clock';
import { useToast } from '../../ui/toast';
import { useSession } from '../session/session';
import { useWorkspace } from './workspace';

/** How long the shortcut starts it for. */
const DEEP_WORK_SHORTCUT_MINUTES = 60;

interface DeepWork {
  /** Until when it lasts, or null when it is off (or over). */
  readonly until: string | null;
  readonly toggle: () => void;
}

const DeepWorkContext = createContext<DeepWork>({ until: null, toggle: () => undefined });

export const useDeepWork = (): DeepWork => useContext(DeepWorkContext);

export const DeepWorkProvider = ({
  children,
}: {
  readonly children: React.ReactNode;
}): React.JSX.Element => {
  const { t } = useI18n();
  const api = useApi();
  const client = useQueryClient();
  const { show } = useToast();
  const describe = useDescribeFailure();
  const { workspace } = useWorkspace();
  const session = useSession();
  const ports = useContext(RealtimePortsContext);
  const clock = ports.clock ?? systemClock;
  const schedule = ports.schedule ?? browserSchedule;
  const stored =
    session.memberships.find((m) => m.workspace.id === workspace.id)?.deepWorkUntil ?? null;
  // The instant whose timer has fired: over, whatever a clock that has not moved says.
  const [over, setOver] = useState<string | null>(null);
  const until =
    stored !== null && stored !== over && new Date(stored) > clock.now() ? stored : null;

  useEffect(() => {
    if (until === null) return undefined;
    return schedule(
      () => {
        setOver(until);
      },
      new Date(until).getTime() - clock.now().getTime(),
    );
  }, [until, schedule, clock]);

  const paint = useCallback(
    (deepWorkUntil: string | null): void => {
      client.setQueryData<MeResponse>(keys.me, (me) =>
        me === undefined
          ? me
          : {
              ...me,
              memberships: me.memberships.map((m) =>
                m.workspace.id === workspace.id ? { ...m, deepWorkUntil } : m,
              ),
            },
      );
    },
    [client, workspace.id],
  );

  const toggle = useCallback((): void => {
    const input: SetDeepWorkRequest =
      until === null
        ? {
            active: true,
            until: new Date(
              clock.now().getTime() + DEEP_WORK_SHORTCUT_MINUTES * 60_000,
            ).toISOString(),
          }
        : { active: false };
    paint(input.active ? input.until : null);
    api.setDeepWork(workspace.id, input).catch((failure: unknown) => {
      paint(until);
      show({ message: `${t('deepWork.failed')} ${describe(failure)}` });
    });
  }, [api, clock, describe, paint, show, t, until, workspace.id]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.isComposing) return;
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'd') {
        event.preventDefault();
        toggle();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return (): void => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [toggle]);

  const value = useMemo(() => ({ until, toggle }), [until, toggle]);
  return <DeepWorkContext.Provider value={value}>{children}</DeepWorkContext.Provider>;
};

/** The quiet bar that says Deep Work is on, until when, with End. */
export const DeepWorkBar = (): React.JSX.Element | null => {
  const { t, format } = useI18n();
  const { until, toggle } = useDeepWork();
  if (until === null) return null;
  return (
    <div
      role="status"
      className="flex shrink-0 items-center gap-2 bg-surface-200 px-4 py-1 text-label text-ink-muted"
    >
      <Icon name="deep-work" size="sm" />
      {t('deepWork.on', { until: format.absolute(until) })}
      <button type="button" onClick={toggle} className="underline">
        {t('deepWork.end')}
      </button>
    </div>
  );
};
