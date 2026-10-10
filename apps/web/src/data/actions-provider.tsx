/** The actions, built once over the page's API and cache and handed to whoever asks. */
import { useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useMemo } from 'react';
import { createActions, type Actions } from './actions';
import { useApi } from './api-provider';
import { useClientStorage } from './storage-provider';

const ActionsContext = createContext<Actions | null>(null);

export const ActionsProvider = ({
  children,
}: {
  readonly children: React.ReactNode;
}): React.JSX.Element => {
  const api = useApi();
  const client = useQueryClient();
  const storage = useClientStorage();
  const actions = useMemo(() => createActions(api, client, storage), [api, client, storage]);
  return <ActionsContext.Provider value={actions}>{children}</ActionsContext.Provider>;
};

export const useActions = (): Actions => {
  const actions = useContext(ActionsContext);
  if (actions === null) throw new Error('useActions was called outside an ActionsProvider');
  return actions;
};
