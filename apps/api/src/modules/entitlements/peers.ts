/**
 * A restriction waits for the cluster (D-292): withdrawing a module from a workspace, or taking away a grant on a server that is
 * `managed`, is believed by the operator and ignored by a node that has never heard of the table. So it is refused while a live
 * node does not read grants. Granting is never refused for it, and a server with no Redis is one node.
 */
import { AppError } from '../../platform/errors';
import type { SuspensionChange } from '../suspension/apply';
import type { EntitlementCatalogue, EntitlementWrite } from './apply';

/** How many live nodes do not read grants; rejects when that cannot be told. Absent where there is one node. */
export type PeersBehind = () => Promise<number>;

/** Whether a write takes something away from a workspace: a withdrawal, or the removal of a grant on a server that gives nothing by default. */
export const restricts = (write: EntitlementWrite, mode: EntitlementCatalogue['mode']): boolean =>
  write.state === 'off' || (write.state === 'inherit' && mode === 'managed');

/**
 * Refuses `409 PEERS_BEHIND` while a live node does not read what is about to be restricted, or when that cannot be told. `reads`
 * is what the nodes must read, in the words of the refusal (`workspace grants`, `the stopped modules`).
 */
const requireNoPeerBehind = async (
  peersBehind: PeersBehind | undefined,
  reads: string,
  action: string,
): Promise<void> => {
  if (peersBehind === undefined) return;
  let behind: number;
  try {
    behind = await peersBehind();
  } catch {
    // When it cannot be told, a restriction is refused: not knowing is no leave to restrict.
    throw new AppError({
      code: 'PEERS_BEHIND',
      message: `Whether every node reads ${reads} could not be checked. Try again.`,
    });
  }
  if (behind > 0)
    throw new AppError({
      code: 'PEERS_BEHIND',
      message: `${String(behind)} node(s) of this cluster do not read ${reads} yet. Finish the rollout, then ${action}.`,
    });
};

export const requirePeersReady = async (
  peersBehind: PeersBehind | undefined,
  catalogue: EntitlementCatalogue,
  writes: readonly EntitlementWrite[],
): Promise<void> => {
  if (!writes.some((write) => restricts(write, catalogue.mode))) return;
  await requireNoPeerBehind(peersBehind, 'workspace grants', 'restrict');
};

/** A stop is a restriction: a node that has never heard of the table would go on serving the module (D-296). Resuming is never refused for it. */
export const requireStopPeersReady = async (
  peersBehind: PeersBehind | undefined,
  change: Pick<SuspensionChange, 'state'>,
): Promise<void> => {
  if (change.state !== 'suspended') return;
  await requireNoPeerBehind(peersBehind, 'the stopped modules', 'stop it');
};
