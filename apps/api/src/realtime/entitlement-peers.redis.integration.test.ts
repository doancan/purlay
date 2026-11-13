/**
 * Which nodes read workspace grants, against a real Redis (D-292): a node that announced its module set and not this is behind,
 * one that says it reads grants is not, a node that left is counted again, and a field of a node nobody else knows is not a peer.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { bunRedisClient, connectRedis, type RedisLink } from '../platform/redis';
import { createLogger } from '../platform/logging';
import { redisUrlForTests } from '../testing/redis';
import {
  advertiseEntitlements,
  advertiseWorkspaceAccess,
  advertiseWorkspaceProvisioning,
  peersBehind,
  workspaceProvisioningPeersBehind,
} from './entitlement-peers';
import { NODE_TTL_MS, moduleSetOf, watchModuleSet } from './module-set';
import { requirePeersReady } from '../modules/entitlements/peers';
import { aRecordingLogger } from '../testing/doubles';

const log = createLogger({ level: 'silent' });
const namespace = `peers-${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
let link: RedisLink;

beforeAll(async () => {
  link = connectRedis({ create: () => bunRedisClient(redisUrlForTests()), log, namespace });
  // Asserts the positive condition: the link is up, not merely that nothing has failed yet.
  for (let waited = 0; !link.connected(); waited += 25) {
    if (waited > 5_000) throw new Error('Redis did not connect');
    await Bun.sleep(25);
  }
});
afterAll(async () => {
  await link.send('DEL', [
    link.names.moduleSet,
    link.names.entitlementNodes,
    link.names.workspaceAccessNodes,
    link.names.workspaceProvisioningNodes,
  ]);
  link.close();
});

const settle = async (): Promise<void> => {
  await Bun.sleep(150);
};

describe('integration: the nodes that read workspace grants', () => {
  test('integration: provisioning readiness distinguishes policy-only peers and a withdrawn capable reader', async () => {
    const legacy = watchModuleSet({
      link,
      nodeId: 'policy-only',
      set: moduleSetOf(['chat']),
      mode: 'open',
      log,
    });
    const capable = watchModuleSet({
      link,
      nodeId: 'source-aware',
      set: moduleSetOf(['chat']),
      mode: 'open',
      log,
    });
    const policyOnly = advertiseWorkspaceAccess({ link, nodeId: 'policy-only', log });
    const current = advertiseWorkspaceProvisioning({ link, nodeId: 'source-aware', log });
    let upgraded: ReturnType<typeof advertiseWorkspaceProvisioning> | undefined;
    try {
      await settle();
      expect(await workspaceProvisioningPeersBehind(link)).toBe(1);
      upgraded = advertiseWorkspaceProvisioning({ link, nodeId: 'policy-only', log });
      await settle();
      expect(await workspaceProvisioningPeersBehind(link)).toBe(0);
      await current.stop();
      expect(await workspaceProvisioningPeersBehind(link)).toBe(1);
      await capable.stop();
      expect(await workspaceProvisioningPeersBehind(link)).toBe(0);
    } finally {
      await current.stop();
      await upgraded?.stop();
      await policyOnly.stop();
      await capable.stop();
      await legacy.stop();
    }
  });
  test('a node of the module set that does not say so is behind, until it does, and again when it leaves', async () => {
    const older = watchModuleSet({
      link,
      nodeId: 'older',
      set: moduleSetOf(['chat']),
      mode: 'open',
      log,
    });
    const newer = watchModuleSet({
      link,
      nodeId: 'newer',
      set: moduleSetOf(['chat']),
      mode: 'open',
      log,
    });
    await settle();
    expect(await peersBehind(link)).toBe(2);

    const newerReads = advertiseEntitlements({ link, nodeId: 'newer', log });
    await settle();
    expect(await peersBehind(link)).toBe(1);

    const olderReads = advertiseEntitlements({ link, nodeId: 'older', log });
    await settle();
    expect(await peersBehind(link)).toBe(0);

    await olderReads.stop();
    expect(await peersBehind(link)).toBe(1);
    await newerReads.stop();
    await older.stop();
    await newer.stop();
    expect(await peersBehind(link)).toBe(0);
  });

  test('a node that says it reads grants and is in no module set is nobody’s peer', async () => {
    const stray = advertiseEntitlements({ link, nodeId: 'stray', log });
    await settle();
    expect(await peersBehind(link)).toBe(0);
    await stray.stop();
  });

  test('renewal removes expired records left by crashed nodes and preserves live peers', async () => {
    // Redis's clock defines both the expired boundary and the peer that must survive pruning.
    await link.script(
      `local time = redis.call('TIME')
local now = time[1] * 1000 + math.floor(time[2] / 1000)
for i = 1, 64 do redis.call('HSET', KEYS[1], 'crashed-' .. i, now) end
redis.call('HSET', KEYS[1], 'live-peer', now + 30000)
return 1`,
      [link.names.entitlementNodes],
      [],
    );
    expect(await link.send('HLEN', [link.names.entitlementNodes])).toBe(65);
    const replacement = advertiseEntitlements({ link, nodeId: 'replacement', log });
    try {
      await settle();
      const retained = await link.send('HKEYS', [link.names.entitlementNodes]);
      expect(retained).toEqual(expect.arrayContaining(['live-peer', 'replacement']));
      expect(retained).toHaveLength(2);
    } finally {
      await replacement.stop();
      await link.send('HDEL', [link.names.entitlementNodes, 'live-peer']);
    }
  });
});

/** What anyone who can write the Redis can put in the records, and what a node does with it (red-team F6). */
describe('integration: a hostile peer cannot freeze the cluster’s restrictions', () => {
  const FAR_FUTURE = Date.now() + 10 * 365 * 86_400_000;
  const fields = async (key: string): Promise<string[]> =>
    (await link.send('HKEYS', [key])) as string[];

  test('a field with no lapse, a lapse that is not a number and a lapse further ahead than a node writes are ignored and removed, and peersBehind still answers', async () => {
    const recording = aRecordingLogger();
    const node = watchModuleSet({
      link,
      nodeId: 'honest',
      set: moduleSetOf(['chat']),
      mode: 'managed',
      log: recording.log,
    });
    const reads = advertiseEntitlements({ link, nodeId: 'honest', log });
    await settle();
    expect(await peersBehind(link)).toBe(0);
    await link.send('HSET', [link.names.moduleSet, 'evil', 'garbage-without-a-separator']);
    await link.send('HSET', [link.names.moduleSet, 'worse', 'soon|chat|open']);
    await link.send('HSET', [link.names.moduleSet, 'ghost', `${String(FAR_FUTURE)}|chat|managed`]);
    await link.send('HSET', [
      link.names.moduleSet,
      'huge',
      `${String(Date.now() + 25_000)}|${'x'.repeat(9000)}`,
    ]);
    await link.send('HSET', [link.names.entitlementNodes, 'garbled', 'not-a-number']);
    await link.send('HSET', [link.names.entitlementNodes, 'ghost', String(FAR_FUTURE)]);

    // Not rejected, and the ghost is not a peer that never reads grants: the honest node is the only live one.
    expect(await peersBehind(link)).toBe(0);
    // Does not throw: a restriction is writable.
    await requirePeersReady(() => peersBehind(link), { carried: [], mode: 'managed' }, [
      { workspaceId: 'w', module: 'issues', state: 'off' },
    ]);

    // The next announcement and the next advertisement take the fields out, so nothing needs deleting by hand, and say so.
    await Bun.sleep(NODE_TTL_MS / 3 + 500);
    expect((await fields(link.names.moduleSet)).sort()).toEqual(['honest']);
    expect((await fields(link.names.entitlementNodes)).sort()).toEqual(['honest']);
    expect(
      recording.lines.some((line) => String(line['msg']).includes('held fields no node writes')),
    ).toBe(true);
    await node.stop();
    await reads.stop();
  }, 20_000);

  test('a field that is a real peer’s own is overwritten by its next renewal and never stops a restriction for good', async () => {
    const node = watchModuleSet({
      link,
      nodeId: 'honest-2',
      set: moduleSetOf(['chat']),
      mode: 'open',
      log,
    });
    const reads = advertiseEntitlements({ link, nodeId: 'honest-2', log });
    await settle();
    await link.send('HSET', [link.names.entitlementNodes, 'honest-2', 'forged']);
    expect(await peersBehind(link)).toBe(1);
    await link.send('HSET', [link.names.entitlementNodes, 'honest-2', String(FAR_FUTURE)]);
    // A capability that lapses in ten years is not one a node writes: the node is behind until its own renewal says otherwise.
    expect(await peersBehind(link)).toBe(1);
    await Bun.sleep(NODE_TTL_MS / 3 + 500);
    expect(await peersBehind(link)).toBe(0);
    await node.stop();
    await reads.stop();
  }, 20_000);
});
