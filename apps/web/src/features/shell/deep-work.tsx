/**
 * Deep Work in the client (D-15, D-108): the server keeps the state and holds back what would
 * interrupt; here the person starts and ends it, sees until when, and the badges keep quiet.
 *
 * - `Cmd/Ctrl+Shift+D` (`UX.md` §7) starts it for an hour, or ends it. The account menu and the
 *   palette start it for a chosen while — half an hour, one, two, or until tomorrow morning — and end
 *   it (D-124): the instant chosen is what the server is sent, and what stops its delivery.
 * - While it lasts a quiet bar says until when, with End (`UX.md` §8: a mode you can forget you are
 *   in is a mode that loses you messages). The mention badges in the sidebar are not drawn; the
 *   counts are still kept, so they are all there when it ends.
 * - It ends by itself at its instant: a timer set for it, and the clock compared when drawn.
 *
 * Painted first: the session's membership changes at once, and a refusal puts it back and says why.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { DEEP_WORK_MAX_HOURS, type MeResponse, type SetDeepWorkRequest } from '@purlay/types';
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

/** The whiles a person can choose, in the order they are offered (D-124). */
export const DEEP_WORK_CHOICES = ['30m', '1h', '2h', 'tomorrow'] as const;
export type DeepWorkChoice = (typeof DEEP_WORK_CHOICES)[number];

/** What the shortcut starts it for. */
const SHORTCUT_CHOICE: DeepWorkChoice = '1h';

const MINUTES = { '30m': 30, '1h': 60, '2h': 120 } as const;

/** The hour "until tomorrow" ends at, in the person's own time: when a working day starts. */
const MORNING_HOUR = 9;

/**
 * Kept back from the server's bound, so a clock here a little ahead of the server's does not turn
 * "until tomorrow" into a refusal.
 */
const BOUND_MARGIN_MS = 5 * 60_000;

/** The instant a choice ends at, from now: tomorrow at nine, never further than the server allows. */
export const deepWorkEnd = (choice: DeepWorkChoice, now: Date): Date => {
  if (choice !== 'tomorrow') return new Date(now.getTime() + MINUTES[choice] * 60_000);
  const morning = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, MORNING_HOUR);
  const bound = now.getTime() + DEEP_WORK_MAX_HOURS * 3_600_000 - BOUND_MARGIN_MS;
  return new Date(Math.min(morning.getTime(), bound));
};

interface DeepWork {
  /** Until when it lasts, or null when it is off (or over). */
  readonly until: string | null;
  readonly toggle: () => void;
  readonly start: (choice: DeepWorkChoice) => void;
  readonly end: () => void;
  /** Whole minutes until it ends, at least one while it lasts; asked when it is drawn. */
  readonly minutesLeft: () => number;
}

const DeepWorkContext = createContext<DeepWork | null>(null);

const OFF: DeepWork = {
  until: null,
  toggle: () => undefined,
  start: () => undefined,
  end: () => undefined,
  minutesLeft: () => 0,
};

/** Deep Work here; off, and changing nothing, outside a workspace. */
export const useDeepWork = (): DeepWork => useContext(DeepWorkContext) ?? OFF;

/** Deep Work's controls, or `null` where nothing keeps it: a caller draws nothing rather than a dead item. */
export const useDeepWorkControls = (): DeepWork | null => useContext(DeepWorkContext);

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

  const send = useCallback(
    (input: SetDeepWorkRequest): void => {
      paint(input.active ? input.until : null);
      api.setDeepWork(workspace.id, input).catch((failure: unknown) => {
        paint(until);
        show({ message: `${t('deepWork.failed')} ${describe(failure)}` });
      });
    },
    [api, describe, paint, show, t, until, workspace.id],
  );

  const start = useCallback(
    (choice: DeepWorkChoice): void => {
      send({ active: true, until: deepWorkEnd(choice, clock.now()).toISOString() });
    },
    [clock, send],
  );

  const end = useCallback((): void => {
    send({ active: false });
  }, [send]);

  const toggle = useCallback((): void => {
    if (until === null) start(SHORTCUT_CHOICE);
    else end();
  }, [end, start, until]);

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

  const minutesLeft = useCallback(
    (): number =>
      until === null
        ? 0
        : Math.max(1, Math.ceil((new Date(until).getTime() - clock.now().getTime()) / 60_000)),
    [clock, until],
  );

  const value = useMemo(
    () => ({ until, toggle, start, end, minutesLeft }),
    [until, toggle, start, end, minutesLeft],
  );
  return <DeepWorkContext.Provider value={value}>{children}</DeepWorkContext.Provider>;
};

/** The quiet bar that says Deep Work is on, until when, with End. */
export const DeepWorkBar = (): React.JSX.Element | null => {
  const { t, format } = useI18n();
  const { until, end } = useDeepWork();
  if (until === null) return null;
  return (
    <div
      role="status"
      className="flex shrink-0 items-center gap-2 bg-surface-200 px-4 py-1 text-label text-ink-muted"
    >
      <Icon name="deep-work" size="sm" />
      {t('deepWork.on', { until: format.absolute(until) })}
      <button type="button" onClick={end} className="underline">
        {t('deepWork.end')}
      </button>
    </div>
  );
};
