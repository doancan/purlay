/** Native session resolution precedes the service's canonical workspace lock and fresh authorization. */
import { Value } from '@sinclair/typebox/value';
import { Uuid } from '@purlay/types';
import type {
  WorkspaceProvisioningActor,
  WorkspaceProvisioningDependencies,
} from '../../modules/workspaces/provisioning/authority';
import { requireWorkspaceMembership, workspaceNotFound } from '../../platform/tenancy';
import { workspacePolicyReadersReady } from '../../platform/workspace-policy-readiness';
import type { RouteContext } from './route-context';
import { requireSession } from './session';

export const workspaceProvisioningDependencies = ({
  dependencies,
  sockets,
}: RouteContext): WorkspaceProvisioningDependencies => ({
  database: dependencies.database,
  clock: dependencies.clock,
  lifetime: () => dependencies.auth.sessionLifetime,
  channels: dependencies.workspaceChannels,
  bus: sockets.bus,
  log: dependencies.log,
  readersReady: async (): Promise<boolean> =>
    await workspacePolicyReadersReady({
      attested: dependencies.config.WORKSPACE_PROVISIONING_READY,
      redisConfigured: dependencies.config.REDIS_URL !== undefined,
      ...(dependencies.workspaceProvisioningPeersBehind === undefined
        ? {}
        : {
            peersBehind: dependencies.workspaceProvisioningPeersBehind,
          }),
    }),
});

export const workspaceProvisioningActor = async (
  { dependencies }: RouteContext,
  request: Request,
  workspaceId: string,
): Promise<WorkspaceProvisioningActor> => {
  const session = await requireSession(dependencies.auth, request);
  if (!Value.Check(Uuid, workspaceId)) throw workspaceNotFound();
  const context = await requireWorkspaceMembership(
    dependencies.database,
    session.userId,
    workspaceId,
  );
  return { context, sessionId: session.sessionId };
};
