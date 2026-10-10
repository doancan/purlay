/**
 * Hands the API to every screen, and nothing else does.
 *
 * A screen asks for `useApi()` and never imports `fetch`, so a component test mounts
 * the real tree with an `Api` it wrote by hand and a screen cannot reach the network
 * by another door. The default is the browser's `fetch` on the same origin — one
 * origin in development as in production (D-61).
 */
import { createContext, useContext, useMemo } from 'react';
import { createApi, type Api } from './api';
import { createHttp } from './http';

const ApiContext = createContext<Api | null>(null);

export const ApiProvider = ({
  api,
  children,
}: {
  readonly api?: Api;
  readonly children: React.ReactNode;
}): React.JSX.Element => {
  const value = useMemo(
    () => api ?? createApi(createHttp((input, init) => fetch(input, init))),
    [api],
  );
  return <ApiContext.Provider value={value}>{children}</ApiContext.Provider>;
};

export const useApi = (): Api => {
  const api = useContext(ApiContext);
  if (api === null) throw new Error('useApi was called outside an ApiProvider');
  return api;
};
