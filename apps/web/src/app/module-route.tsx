/**
 * A module's screen, drawn from its manifest (D-250, `docs/MODULES.md` §6): the one component every route a module
 * declares is, inside `ModuleGate`, with what stands in for the screen while the module's chunk comes. `Outlet` puts
 * it in the `Shell`, the same one the core's screens of the workspace are in, so a change from one to the other
 * keeps the shell standing.
 *
 * **The chunk is one request, shared by every screen of the module** (`chunkOf`), and `warmModule` asks for it
 * before anything waits on it: `Outlet` calls it in the first commit of a route whose module says `preload`, in
 * parallel with the request for the session, so the chunk is not a second wait. A server that does not run the
 * module costs one chunk to a person who opens such an address; `ModuleGate` still shows it as not found. A failed
 * request is forgotten, so the next door asks again.
 *
 * The stand-in is part of what a cold load is measured to: a `bar` module's is the shell's own `ScreenBar`, which
 * holds the navigation toggle on a narrow window, and without it the frame is late (123 ms to 200 ms narrow).
 */
import { lazy, Suspense, type ComponentType, type LazyExoticComponent } from 'react';
import { ModuleGate } from '../features/shell/module-gate';
import { ScreenBar } from '../features/shell/screen-bar';
import { useI18n } from '../i18n/i18n-provider';
import type { ModuleChunk, ModuleManifest } from '../modules/manifest';
import { MODULES } from '../modules/registry';
import type { ModuleRouteName } from '../router/routes';
import { LoadingStatus, Skeleton } from '../ui/skeleton';
import { chunkOf } from './chunk';

type Params = Readonly<Record<string, string>> & { readonly slug: string };
type Screen = LazyExoticComponent<ComponentType<{ readonly params: Params }>>;

const MANIFESTS: readonly ModuleManifest[] = MODULES;
const CHUNKS = new Map(MANIFESTS.map((module) => [module.id, chunkOf(module.load)] as const));

/** A module's chunk, by its id: one request however many ask. */
export const moduleChunk = (id: string): ReturnType<typeof chunkOf<ModuleChunk>> => {
  const chunk = CHUNKS.get(id);
  if (chunk === undefined) throw new Error(`no module is called ${id}`);
  return chunk;
};

/** Asks for a module's chunk now, if its manifest says to; `Outlet` calls it with the owner of the route. */
export const warmModule = (id: string | null): void => {
  if (id !== null && MANIFESTS.find((module) => module.id === id)?.preload === true) {
    moduleChunk(id).warm();
  }
};

/**
 * A route's screen out of its module's chunk. The chunk's `screens` are typed to the manifest's routes
 * (`ModuleScreens`); here they are looked up by name, so a chunk that lacks one is said by name rather than left to
 * fail as `undefined is not a constructor` somewhere inside React.
 */
export const screenOf = (
  chunk: ModuleChunk,
  module: string,
  route: string,
): ComponentType<{ readonly params: Params }> => {
  const screen = chunk.screens[route];
  if (screen === undefined) {
    throw new Error(`the ${module} module's chunk has no screen for the route ${route}`);
  }
  return screen as ComponentType<{ readonly params: Params }>;
};

const SCREENS = new Map<string, { readonly screen: Screen; readonly waiting: 'bar' | 'plain' }>(
  MANIFESTS.flatMap((module) =>
    Object.keys(module.routes).map((route) => {
      const screen = lazy(async () => ({
        default: screenOf(await moduleChunk(module.id).get(), module.id, route),
      }));
      return [route, { screen, waiting: module.waiting }] as const;
    }),
  ),
);

/** What stands in for a screen: for `bar`, the shell's bar and the skeleton a screen draws while its own data comes. */
export const Waiting = ({ kind }: { readonly kind: 'bar' | 'plain' }): React.JSX.Element => {
  const { t } = useI18n();
  if (kind === 'plain') {
    return (
      <LoadingStatus label={t('common.loading')} className="flex w-full flex-col gap-3 p-10">
        <Skeleton />
        <Skeleton />
        <Skeleton />
      </LoadingStatus>
    );
  }
  return (
    <>
      <ScreenBar />
      <LoadingStatus label={t('common.loading')} className="p-4">
        <Skeleton className="w-sidebar" />
      </LoadingStatus>
    </>
  );
};

interface ModuleRouteProps {
  readonly name: ModuleRouteName;
  readonly params: Params;
}

export const ModuleRoute = ({ name, params }: ModuleRouteProps): React.JSX.Element => {
  const entry = SCREENS.get(name);
  if (entry === undefined) throw new Error(`no module declares the route ${name}`);
  const { screen: Door, waiting } = entry;
  return (
    <ModuleGate route={name}>
      <Suspense fallback={<Waiting kind={waiting} />}>
        <Door params={params} />
      </Suspense>
    </ModuleGate>
  );
};
