/**
 * Mounts the realtime engine for a signed-in page, and says what it is doing.
 *
 * One engine for the life of the page: it connects when the page does, watches every
 * channel the person is in (the list is the cache's, so a channel joined or added
 * arrives here without anyone calling anything), and stops with the page. What a
 * screen needs from it — send, retry, discard, the connection's state and the rows
 * still in flight — is on the context; the store behind it is Zustand's and is read
 * through a selector, so a screen re-renders only for what it asked about.
 *
 * The ports are the browser's by default and a test's when given: the socket, the
 * timers, the dice and the clock are arguments (D-46).
 */
import { useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useMemo } from 'react';
import { useStore } from 'zustand';
import { useApi } from '../data/api-provider';
import { keys } from '../data/keys';
import { useClientStorage } from '../data/storage-provider';
import { useChannels } from '../data/queries';
import { useSession } from '../features/session/session';
import { useWorkspace } from '../features/shell/workspace';
import { systemClock } from '../system-clock';
import type { Clock } from './clock';
import type { ConnectionStatus, OpenSocket, Schedule } from './connection';
import { createEngine, type DegradedReason, type Engine, type PendingMessage } from './engine';
import { browserSchedule, browserSocket } from './socket';

export interface RealtimePorts {
  readonly openSocket?: OpenSocket;
  readonly schedule?: Schedule;
  readonly random?: () => number;
  readonly clock?: Clock;
  readonly url?: string;
}

const EngineContext = createContext<Engine | null>(null);

/** The page's ports, set once by the application's providers so a test can swap the browser's out. */
export const RealtimePortsContext = createContext<RealtimePorts>({});

/** `ws://` or `wss://` on the page's own origin, which is the API's too (D-61). */
const socketUrl = (): string => {
  const secure = window.location.protocol === 'https:';
  return `${secure ? 'wss' : 'ws'}://${window.location.host}/ws`;
};

export const RealtimeProvider = ({
  children,
}: {
  readonly children: React.ReactNode;
}): React.JSX.Element => {
  const ports = useContext(RealtimePortsContext);
  const api = useApi();
  const client = useQueryClient();
  const { workspace } = useWorkspace();
  const { user } = useSession();
  const storage = useClientStorage();
  const channels = useChannels(workspace.id);

  const engine = useMemo(
    () =>
      createEngine({
        api,
        client,
        url: ports.url ?? socketUrl(),
        openSocket: ports.openSocket ?? browserSocket,
        schedule: ports.schedule ?? browserSchedule,
        random: ports.random ?? Math.random,
        clock: ports.clock ?? systemClock,
        userId: user.id,
        storage,
        // The identity answer is what says whether the session is still there.
        onSessionEnded: () => {
          void client.invalidateQueries({ queryKey: keys.me });
        },
      }),
    [
      api,
      client,
      user.id,
      storage,
      ports.url,
      ports.openSocket,
      ports.schedule,
      ports.random,
      ports.clock,
    ],
  );

  useEffect(() => {
    engine.start();
    return (): void => {
      engine.stop();
    };
  }, [engine]);

  // Channels the person is a member of, and only those: one they can merely see has no
  // subscription to hold, and the server would refuse it.
  const memberOf = useMemo(
    () => (channels.data ?? []).filter((c) => c.state !== null).map((c) => c.id),
    [channels.data],
  );
  useEffect(() => {
    engine.watch(memberOf);
  }, [engine, memberOf]);

  return <EngineContext.Provider value={engine}>{children}</EngineContext.Provider>;
};

export const useEngine = (): Engine => {
  const engine = useContext(EngineContext);
  if (engine === null) throw new Error('useEngine was called outside a RealtimeProvider');
  return engine;
};

export const useConnectionStatus = (): ConnectionStatus =>
  useStore(useEngine().store, (state) => state.status);

/** Channels whose live updates are not trustworthy right now, and why. */
export const useDegraded = (): Readonly<Record<string, DegradedReason>> =>
  useStore(useEngine().store, (state) => state.degraded);

/** Every message in flight, across channels; filter with `useMemo` where a screen wants one channel's. */
export const usePending = (): readonly PendingMessage[] =>
  useStore(useEngine().store, (state) => state.pending);
