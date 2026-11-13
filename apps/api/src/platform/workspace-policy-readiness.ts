/** API peer presence cannot attest that schedulers and deferred output readers have been upgraded (D-310). */
export interface WorkspacePolicyReadiness {
  readonly attested: boolean;
  readonly redisConfigured: boolean;
  readonly peersBehind?: () => Promise<number>;
}

export const workspacePolicyReadersReady = async (
  input: WorkspacePolicyReadiness,
): Promise<boolean> => {
  if (!input.attested) return false;
  if (input.peersBehind === undefined) return !input.redisConfigured;
  try {
    return (await input.peersBehind()) === 0;
  } catch {
    return false;
  }
};
