/**
 * A screen of a module the server may not run (D-250): where the session does not list the module, the address is
 * not found, as the server's own answer for the same path is.
 */
import { moduleOf, type RouteName } from '../../router/routes';
import { useRuns, useSession } from '../session/session';
import { NotFound } from './not-found';

interface ModuleGateProps {
  readonly route: RouteName;
  readonly children: React.ReactNode;
}

export const ModuleGate = ({ route, children }: ModuleGateProps): React.JSX.Element => {
  const { modules } = useSession();
  const owner = moduleOf(route);
  return owner === null || modules.includes(owner) ? <>{children}</> : <NotFound />;
};

/**
 * What only a module's screens need — a request, a socket reader, a shortcut — drawn only where the server runs it, so
 * a process without the module is not asked for what it would answer with 404.
 */
export const WhenRun = ({
  module,
  children,
}: {
  readonly module: string;
  readonly children: React.ReactNode;
}): React.JSX.Element | null => (useRuns(module) ? <>{children}</> : null);
