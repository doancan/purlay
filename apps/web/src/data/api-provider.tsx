/**
 * Hands the API to every screen, and nothing else does.
 *
 * A screen asks for `useApi()` and never imports `fetch`, so a component test mounts
 * the real tree with an `Api` it wrote by hand and a screen cannot reach the network
 * by another door. The default is the browser's `fetch` on the same origin — one
 * origin in development as in production (D-61).
 */
import { createContext, useContext, useMemo, useRef, useCallback } from 'react';
import { createApi, type Api } from './api';
import { createHttp } from './http';
import { QueryClientContext } from '@tanstack/react-query';
import { workspaceAccessRequired } from './access-change';
import { useRoute } from '../router/router-provider';
import { contentWorkspaceSlug } from '../router/routes';
import { keys } from './keys';
import type { MeResponse } from '@purlay/types';

const ApiContext = createContext<Api | null>(null);

export const ApiProvider = ({
  api,
  children,
  activeWorkspace,
}: {
  readonly activeWorkspace?: () => string | null;
  readonly api?: Api;
  readonly children: React.ReactNode;
}): React.JSX.Element => {
  const client = useContext(QueryClientContext);
  const value = useMemo(
    () =>
      api ??
      createApi(
        createHttp(
          (input, init) => fetch(input, init),
          undefined,
          undefined,
          (error) => {
            if (
              client !== undefined &&
              error.code === 'WORKSPACE_ACCESS_REQUIRED' &&
              error.workspaceId !== null
            )
              workspaceAccessRequired(client, error.workspaceId);
          },
          activeWorkspace,
        ),
      ),
    [api, client, activeWorkspace],
  );
  return <ApiContext.Provider value={value}>{children}</ApiContext.Provider>;
};

export const useApi = (): Api => {
  const api = useContext(ApiContext);
  if (api === null) throw new Error('useApi was called outside an ApiProvider');
  return api;
};

/** Browser-only assembly seam. Navigation changes the reader, never the stable API/engine identity. */
export const BrowserApiProvider = ({
  api,
  children,
}: {
  readonly api?: Api;
  readonly children: React.ReactNode;
}): React.JSX.Element => {
  const client = useContext(QueryClientContext);
  const { match } = useRoute();
  const route = useRef(match);
  route.current = match;
  const activeWorkspace = useCallback((): string | null => {
    if (
      typeof document === 'undefined' ||
      document.visibilityState !== 'visible' ||
      !document.hasFocus()
    )
      return null;
    const slug = contentWorkspaceSlug(route.current);
    if (slug === null) return null;
    return (
      client
        ?.getQueryData<MeResponse>(keys.me)
        ?.memberships.find((member) => member.workspace.slug === slug)?.workspace.id ?? null
    );
  }, [client]);
  return (
    <ApiProvider {...(api === undefined ? {} : { api })} activeWorkspace={activeWorkspace}>
      {children}
    </ApiProvider>
  );
};
