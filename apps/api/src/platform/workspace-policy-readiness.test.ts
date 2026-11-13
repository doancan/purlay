import { expect, test } from 'bun:test';
import { workspacePolicyReadersReady } from './workspace-policy-readiness';

test('only an explicit operator attestation can confirm deferred-reader readiness', async () => {
  for (const redisConfigured of [false, true]) {
    expect(await workspacePolicyReadersReady({ attested: false, redisConfigured })).toBe(false);
    expect(
      await workspacePolicyReadersReady({
        attested: false,
        redisConfigured,
        peersBehind: () => Promise.resolve(0),
      }),
    ).toBe(false);
  }
  expect(await workspacePolicyReadersReady({ attested: true, redisConfigured: false })).toBe(true);
  expect(await workspacePolicyReadersReady({ attested: true, redisConfigured: true })).toBe(false);
});

test('a known incompatible peer or an unavailable registry prevents enforcement', async () => {
  for (const count of [1, -1, NaN, Infinity])
    expect(
      await workspacePolicyReadersReady({
        attested: true,
        redisConfigured: true,
        peersBehind: () => Promise.resolve(count),
      }),
    ).toBe(false);
  expect(
    await workspacePolicyReadersReady({
      attested: true,
      redisConfigured: true,
      peersBehind: () => Promise.reject(new Error('registry unavailable')),
    }),
  ).toBe(false);
  expect(
    await workspacePolicyReadersReady({
      attested: true,
      redisConfigured: true,
      peersBehind: () => Promise.resolve(0),
    }),
  ).toBe(true);
});
