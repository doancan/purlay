/**
 * Which nodes read workspace grants, against a real Redis (D-292): a node that announced its module set and not this is behind,
 * one that says it reads grants is not, a node that left is counted again, and a field of a node nobody else knows is not a peer.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { bunRedisClient, connectRedis, type RedisLink } from '../platform/redis';
import { createLogger } from '../platform/logging';
import { redisUrlForTests } from '../testing/redis';
import { advertiseEntitlements, peersBehind } from './entitlement-peers';
import { moduleSetOf, watchModuleSet } from './module-set';

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
  await link.send('DEL', [link.names.moduleSet, link.names.entitlementNodes]);
  link.close();
});

const settle = async (): Promise<void> => {
  await Bun.sleep(150);
};

describe('integration: the nodes that read workspace grants', () => {
  test('a node of the module set that does not say so is behind, until it does, and again when it leaves', async () => {
    const older = watchModuleSet({ link, nodeId: 'older', set: moduleSetOf(['chat']), log });
    const newer = watchModuleSet({ link, nodeId: 'newer', set: moduleSetOf(['chat']), log });
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
});
