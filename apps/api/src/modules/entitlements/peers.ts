/**
 * A restriction waits for the cluster (D-292): withdrawing a module from a workspace, or taking away a grant on a server that is
 * `managed`, is believed by the operator and ignored by a node that has never heard of the table. So it is refused while a live
 * node does not read grants. Granting is never refused for it, and a server with no Redis is one node.
 */
import { AppError } from '../../platform/errors';
import type { EntitlementCatalogue, EntitlementWrite } from './apply';

/** How many live nodes do not read grants; rejects when that cannot be told. Absent where there is one node. */
export type PeersBehind = () => Promise<number>;

/** Whether a write takes something away from a workspace: a withdrawal, or the removal of a grant on a server that gives nothing by default. */
export const restricts = (write: EntitlementWrite, mode: EntitlementCatalogue['mode']): boolean =>
  write.state === 'off' || (write.state === 'inherit' && mode === 'managed');

export const requirePeersReady = async (
  peersBehind: PeersBehind | undefined,
  catalogue: EntitlementCatalogue,
  writes: readonly EntitlementWrite[],
): Promise<void> => {
  if (peersBehind === undefined || !writes.some((write) => restricts(write, catalogue.mode)))
    return;
  let behind: number;
  try {
    behind = await peersBehind();
  } catch {
    // When it cannot be told, a restriction is refused: not knowing is no leave to restrict.
    throw new AppError({
      code: 'PEERS_BEHIND',
      message: 'Whether every node reads workspace grants could not be checked. Try again.',
    });
  }
  if (behind > 0)
    throw new AppError({
      code: 'PEERS_BEHIND',
      message: `${String(behind)} node(s) of this cluster do not read workspace grants yet. Finish the rollout, then restrict.`,
    });
};
