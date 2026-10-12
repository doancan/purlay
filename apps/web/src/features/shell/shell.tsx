/**
 * The signed-in frame: who, which workspace, the realtime connection, and the three regions
 * every screen sits beside — the rail, the sidebar and the main column (`UX.md` §2, D-110).
 *
 * Flat: the rail and the sidebar share the navigation tone, the main column is the window's
 * ground, and one hairline divides them. The main column is what every screen renders into.
 *
 * The order is the dependency order: a person (or the sign-in screen) before a
 * workspace, a workspace before the connection (which watches *its* channels), the
 * connection before any screen that sends. A screen below this may use `useSession`,
 * `useWorkspace`, `useEngine` and the data hooks without asking whether they are
 * ready.
 */
import { RealtimeProvider } from '../../realtime/realtime-provider';
import { Main } from '../../ui/main';
import { SessionGate } from '../session/session';
import { ConnectionBar } from './connection-bar';
import { UpdateBar } from './update-bar';
import { DeepWorkBar, DeepWorkProvider } from './deep-work';
import { GlobalKeys } from './global-keys';
import { NotFound } from './not-found';
import { NavProvider } from './nav';
import { OverlayProvider } from './overlay';
import { SidebarSlot } from './sidebar-slot';
import { WorkspaceScopeProvider } from './workspace';

export const Shell = ({
  slug,
  children,
}: {
  readonly slug: string;
  readonly children: React.ReactNode;
}): React.JSX.Element => (
  <SessionGate>
    <WorkspaceScopeProvider slug={slug} notFound={<NotFound />}>
      <RealtimeProvider>
        <OverlayProvider>
          <DeepWorkProvider>
            <GlobalKeys />
            <NavProvider>
              <div className="flex h-screen bg-surface-100 text-ink">
                <SidebarSlot />
                <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
                  <ConnectionBar />
                  <UpdateBar />
                  <DeepWorkBar />
                  <Main className="flex min-h-0 flex-1 flex-col">{children}</Main>
                </div>
              </div>
            </NavProvider>
          </DeepWorkProvider>
        </OverlayProvider>
      </RealtimeProvider>
    </WorkspaceScopeProvider>
  </SessionGate>
);
