/**
 * What every step of the wizard reaches for: the client, a way to read the state again after a
 * change, and a way to say the claim is gone. A step never holds the query itself — it changes
 * something and says so, and the one state query is invalidated here (never polled, never read on
 * window focus: the status shares the sign-in rate-limit bucket).
 */
import { useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useMemo } from 'react';
import type { SetupClient } from './client';

export const SETUP_STATE_KEY = ['setup', 'state'] as const;

interface SetupContextValue {
  readonly client: SetupClient;
  /** The state, read again: after a step changed something. */
  readonly refresh: () => Promise<void>;
  /** The server no longer knows this browser's claim: back to the code, with the sentence why. */
  readonly lose: () => void;
}

const SetupContext = createContext<SetupContextValue | null>(null);

export const SetupProvider = ({
  client,
  onLost,
  children,
}: {
  readonly client: SetupClient;
  readonly onLost: () => void;
  readonly children: React.ReactNode;
}): React.JSX.Element => {
  const queries = useQueryClient();
  const value = useMemo<SetupContextValue>(
    () => ({
      client,
      refresh: async (): Promise<void> => {
        await queries.invalidateQueries({ queryKey: SETUP_STATE_KEY });
      },
      lose: onLost,
    }),
    [client, queries, onLost],
  );
  return <SetupContext.Provider value={value}>{children}</SetupContext.Provider>;
};

export const useSetup = (): SetupContextValue => {
  const value = useContext(SetupContext);
  if (value === null) throw new Error('useSetup was called outside a SetupProvider');
  return value;
};
