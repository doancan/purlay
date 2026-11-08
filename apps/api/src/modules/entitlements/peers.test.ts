import { describe, expect, test } from 'bun:test';
import type { EntitlementCatalogue, EntitlementWrite } from './apply';
import { requirePeersReady, requireStopPeersReady } from './peers';

const catalogue = (mode: EntitlementCatalogue['mode']): EntitlementCatalogue => ({
  mode,
  carried: [{ id: 'issues', requires: [] }],
});
const write = (state: EntitlementWrite['state']): EntitlementWrite => ({
  workspaceId: crypto.randomUUID(),
  module: 'issues',
  state,
});

const outcome = async (attempt: Promise<void>): Promise<string> => {
  try {
    await attempt;
    return 'allowed';
  } catch (error) {
    return (error as { body: { code: string } }).body.code;
  }
};

describe('a restriction waits for the cluster', () => {
  const behind =
    (count: number): (() => Promise<number>) =>
    () =>
      Promise.resolve(count);

  test('withdrawing a module is refused while a node does not read grants, and allowed when every node does', async () => {
    expect(await outcome(requirePeersReady(behind(1), catalogue('open'), [write('off')]))).toBe(
      'PEERS_BEHIND',
    );
    expect(await outcome(requirePeersReady(behind(0), catalogue('open'), [write('off')]))).toBe(
      'allowed',
    );
  });

  test('granting is never refused for it', async () => {
    expect(await outcome(requirePeersReady(behind(3), catalogue('managed'), [write('on')]))).toBe(
      'allowed',
    );
    expect(await outcome(requirePeersReady(behind(3), catalogue('open'), [write('inherit')]))).toBe(
      'allowed',
    );
  });

  test('taking a grant away is a restriction on a managed server and not on an open one', async () => {
    expect(
      await outcome(requirePeersReady(behind(1), catalogue('managed'), [write('inherit')])),
    ).toBe('PEERS_BEHIND');
  });

  test('one restriction in a batch of grants is enough', async () => {
    expect(
      await outcome(requirePeersReady(behind(1), catalogue('open'), [write('on'), write('off')])),
    ).toBe('PEERS_BEHIND');
  });

  test('where there is one node, nothing is asked', async () => {
    expect(await outcome(requirePeersReady(undefined, catalogue('managed'), [write('off')]))).toBe(
      'allowed',
    );
  });

  test('when the cluster cannot be asked, a restriction is refused rather than guessed', async () => {
    const failing = (): Promise<number> => Promise.reject(new Error('redis is away'));
    expect(await outcome(requirePeersReady(failing, catalogue('open'), [write('off')]))).toBe(
      'PEERS_BEHIND',
    );
    expect(await outcome(requirePeersReady(failing, catalogue('open'), [write('on')]))).toBe(
      'allowed',
    );
  });
});

describe('a stop waits for the cluster (D-296)', () => {
  const behind =
    (count: number): (() => Promise<number>) =>
    () =>
      Promise.resolve(count);

  test('is refused while a node does not read the stopped modules, naming what they must read', async () => {
    expect(await outcome(requireStopPeersReady(behind(2), { state: 'suspended' }))).toBe(
      'PEERS_BEHIND',
    );
    try {
      await requireStopPeersReady(behind(2), { state: 'suspended' });
    } catch (error) {
      expect((error as Error).message).toContain('2 node(s)');
      expect((error as Error).message).toContain('the stopped modules');
    }
    expect(await outcome(requireStopPeersReady(behind(0), { state: 'suspended' }))).toBe('allowed');
  });

  test('is never asked of a resume, and not of a single node', async () => {
    expect(await outcome(requireStopPeersReady(behind(5), { state: 'running' }))).toBe('allowed');
    expect(await outcome(requireStopPeersReady(undefined, { state: 'suspended' }))).toBe('allowed');
  });

  test('is refused rather than guessed when the cluster cannot be asked', async () => {
    const failing = (): Promise<number> => Promise.reject(new Error('redis is away'));
    expect(await outcome(requireStopPeersReady(failing, { state: 'suspended' }))).toBe(
      'PEERS_BEHIND',
    );
    expect(await outcome(requireStopPeersReady(failing, { state: 'running' }))).toBe('allowed');
  });
});
