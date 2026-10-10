/**
 * The signed-in frame: who, which workspace, the realtime connection, and the two
 * cards every screen sits in — the sidebar and the main column (`UX.md` §2, D-100).
 *
 * The window is the canvas and the two cards float on it. The main column's card is what every
 * screen renders into, and it clips them to its corners.
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
          <GlobalKeys />
          <NavProvider>
            <div className="flex h-screen gap-2 bg-canvas p-2 text-ink max-narrow:p-1">
              <SidebarSlot />
              <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-lg bg-surface-100 shadow-card">
                <ConnectionBar />
                <Main className="flex min-h-0 flex-1 flex-col">{children}</Main>
              </div>
            </div>
          </NavProvider>
        </OverlayProvider>
      </RealtimeProvider>
    </WorkspaceScopeProvider>
  </SessionGate>
);
