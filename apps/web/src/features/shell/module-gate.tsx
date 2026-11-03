/**
 * A screen of a module the server may not run (D-250): where the session does not list the module, the address is
 * not found, as the server's own answer for the same path is.
 */
import { moduleOf, type RouteName } from '../../router/routes';
import { useSession } from '../session/session';
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
