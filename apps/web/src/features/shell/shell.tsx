/**
 * The signed-in frame: who, which workspace, the realtime connection, and the two
 * regions every screen sits in — the sidebar and the main column (`UX.md` §2).
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
import { GlobalKeys } from './global-keys';
import { NotFound } from './not-found';
import { Sidebar } from './sidebar';
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
        <GlobalKeys />
        <div className="flex h-screen bg-surface-100 text-ink">
          <Sidebar />
          <Main className="flex min-w-0 flex-1 flex-col">{children}</Main>
        </div>
      </RealtimeProvider>
    </WorkspaceScopeProvider>
  </SessionGate>
);
