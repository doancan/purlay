/** Policy identity ignores allowlist order; missing or unknown rollout readiness never authorizes enforcement. */
import { expect, test } from 'bun:test';
import { requirePolicyReadersReady } from './policy-authority';
import {
  canonicalWorkspacePolicy,
  defaultWorkspacePolicy,
  workspacePolicyDigest,
} from './policy-state';

test('the canonical policy digest is order-insensitive and preserves meaningful changes', async () => {
  const a = crypto.randomUUID();
  const b = crypto.randomUUID();
  const policy = { ...defaultWorkspacePolicy(), allowedConnectionIds: [a, b] };
  expect(
    (await workspacePolicyDigest(policy)).equals(
      await workspacePolicyDigest({ ...policy, allowedConnectionIds: [b, a] }),
    ),
  ).toBe(true);
  expect(
    (await workspacePolicyDigest(policy)).equals(
      await workspacePolicyDigest({ ...policy, requireMfa: true }),
    ),
  ).toBe(false);
});

test('only a true reader attestation authorizes enforcement', async () => {
  for (const input of [
    {},
    { policyReadersReady: (): Promise<boolean> => Promise.resolve(false) },
    { policyReadersReady: (): Promise<boolean> => Promise.reject(new Error('unavailable')) },
  ]) {
    const result = await requirePolicyReadersReady(input).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(result).toMatchObject({ body: { code: 'PEERS_BEHIND' } });
  }
  await requirePolicyReadersReady({ policyReadersReady: () => Promise.resolve(true) });
});

test('bounded policy settings reject invalid service inputs before constructing a policy identity', () => {
  expect(() => canonicalWorkspacePolicy({ ...defaultWorkspacePolicy(), idleMinutes: 2 })).toThrow(
    'The request did not match the contract.',
  );
  expect(() =>
    canonicalWorkspacePolicy({
      ...defaultWorkspacePolicy(),
      allowedConnectionIds: Array.from({ length: 17 }, () => crypto.randomUUID()),
    }),
  ).toThrow('The request did not match the contract.');
});
