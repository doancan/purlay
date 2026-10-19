/**
 * The router, for components: where we are, how to move, and the `Link`.
 *
 * **`Link` is an anchor.** It has a real `href`, so middle-click, "open in new
 * tab", copy-link and a screen reader's links list all work with no help from
 * script. It only takes over the one case it can do better — a plain left click
 * on a same-origin address — and leaves everything else to the browser: any
 * modifier key, a non-primary button, `target`, `download`, and a click something
 * else has already handled.
 */
import { createContext, useContext, useMemo, useState, useSyncExternalStore } from 'react';
import {
  browserHistory,
  createRouter,
  type HistoryPort,
  type Location,
  type NavigateOptions,
  type Router,
} from './router';
import { spell, type RouteName, type RouteParams } from './routes';

const RouterContext = createContext<Router | null>(null);

interface RouterProviderProps {
  readonly history?: HistoryPort;
  readonly children: React.ReactNode;
}

export const RouterProvider = ({ history, children }: RouterProviderProps): React.JSX.Element => {
  // Built when the provider first renders, not at import: the build prerenders
  // the shell with no `window` (D-50).
  const [router] = useState(() => createRouter(history ?? browserHistory()));
  return <RouterContext value={router}>{children}</RouterContext>;
};

const useRouter = (): Router => {
  const router = useContext(RouterContext);
  if (router === null) throw new Error('the router hooks need a <RouterProvider> above them');
  return router;
};

export interface UseRoute extends Location {
  /** Goes to an address, or to a named route; `replace` for a redirect Back must skip. */
  readonly navigate: (url: string, options?: NavigateOptions) => void;
}

export const useRoute = (): UseRoute => {
  const router = useRouter();
  const location = useSyncExternalStore(router.subscribe, router.getSnapshot, router.getSnapshot);
  return useMemo(() => ({ ...location, navigate: router.navigate }), [location, router]);
};

type LinkProps<N extends RouteName> = Omit<React.ComponentPropsWithoutRef<'a'>, 'href'> & {
  readonly to: N;
  /** A query for the address, without its `?` (`narrowedTo` in `routes.ts`). */
  readonly search?: string;
} & (keyof RouteParams<N> extends never
    ? { readonly params?: undefined }
    : { readonly params: RouteParams<N> });

const handledByBrowser = (event: React.MouseEvent<HTMLAnchorElement>): boolean =>
  event.defaultPrevented ||
  event.button !== 0 ||
  event.metaKey ||
  event.ctrlKey ||
  event.shiftKey ||
  event.altKey ||
  (event.currentTarget.target !== '' && event.currentTarget.target !== '_self') ||
  event.currentTarget.hasAttribute('download');

export const Link = <N extends RouteName>({
  to,
  params,
  search,
  onClick,
  ...rest
}: LinkProps<N>): React.JSX.Element => {
  const { navigate, pathname } = useRoute();
  const address = search === undefined ? spell(to, params) : `${spell(to, params)}?${search}`;
  return (
    <a
      {...rest}
      href={address}
      aria-current={pathname === address ? 'page' : rest['aria-current']}
      onClick={(event) => {
        onClick?.(event);
        if (handledByBrowser(event)) return;
        event.preventDefault();
        navigate(address);
      }}
    />
  );
};
