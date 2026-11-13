/**
 * An endpoint cannot be served without a cross-tenant case, or the build fails.
 *
 * Runs without a database, in `bun run verify`, so the omission is caught before
 * the integration job is reached. The crossings themselves are in
 * `cross-tenant.integration.test.ts`. (D-21, D-63)
 */
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'bun:test';
import { createApp } from '../ingress/http/app';
import {
  CROSS_TENANT,
  WORKFLOW_CROSS_TENANT,
  EMPTY_FOR_THE_SEED,
  UNSCOPED,
  WORKSPACE_WIDE_READS,
  documentedEndpoints,
  endpointKey,
  listEndpoints,
  queriesFor,
  rowsIn,
  type DocumentedEndpoint,
} from './cross-tenant';
import { testDependencies } from './doubles';

const SOME_ID = '00000000-0000-4000-8000-000000000000';

/**
 * The size `EMPTY_FOR_THE_SEED` may have, the list of lists the one-member-two-workspaces check cannot prove anything about. An
 * entry is a list whose isolation is not shown, so one joins only with this raised in the same change, which is a line a
 * reviewer reads and has to accept; a module's list is seeded in `aTenant` instead (`MODULES.md` §9 item 4).
 */
const MAX_EMPTY_FOR_THE_SEED = 1;

/**
 * Whether the application has a route for this endpoint.
 *
 * Asked without a session and with a database that throws if touched, so the
 * answer is the router's alone: an unrouted request is `ROUTE_NOT_FOUND`, and a
 * routed one is anything else — `401` here, almost always.
 */
const isServed = async (endpoint: DocumentedEndpoint): Promise<boolean> => {
  const response = await createApp(testDependencies()).handle(
    // Any id routes; which id it is matters only to a crossing.
    new Request(`https://purlay.test${endpoint.path.replace(/:\w+/g, SOME_ID)}`, {
      method: endpoint.method,
    }),
  );
  const body = (await response.json()) as { error?: { code?: string } };
  return body.error?.code !== 'ROUTE_NOT_FOUND';
};

describe('the endpoint list is read from the repository, not from the working directory', () => {
  test('the same endpoints are found from a directory that is not the repository root', () => {
    const here = documentedEndpoints();
    const original = process.cwd();
    process.chdir(tmpdir());
    try {
      expect(documentedEndpoints()).toEqual(here);
    } finally {
      process.chdir(original);
    }
    expect(here.length).toBeGreaterThan(10);
  });
});

describe('every served endpoint has a cross-tenant case', () => {
  const documented = documentedEndpoints();
  const keys = new Set(documented.map(endpointKey));

  test('the endpoint tables are actually being read', () => {
    // A parser that matched nothing would make every assertion below vacuous.
    expect(keys.has('GET /api/me')).toBe(true);
    expect(keys.has('GET /api/channels/:channelId/messages')).toBe(true);
    expect(keys.has('POST /api/webhooks/github/:feedId')).toBe(true);
  });

  test('the router check can answer no', async () => {
    // Otherwise "served" would be true of everything and the next test would pass by accident.
    expect(await isServed({ method: 'GET', path: '/api/never-documented' })).toBe(false);
    expect(await isServed({ method: 'GET', path: '/api/me' })).toBe(true);
  });

  test('each documented endpoint that is served is classified exactly once', async () => {
    const unclassified: string[] = [];
    for (const endpoint of documented) {
      const key = endpointKey(endpoint);
      const inCases = key in CROSS_TENANT;
      const inWorkflow = key in WORKFLOW_CROSS_TENANT;
      const inUnscoped = key in UNSCOPED;
      expect({
        key,
        classifications: Number(inCases) + Number(inWorkflow) + Number(inUnscoped),
      }).toEqual({ key, classifications: inCases || inWorkflow || inUnscoped ? 1 : 0 });
      if (!inCases && !inWorkflow && !inUnscoped && (await isServed(endpoint)))
        unclassified.push(key);
    }
    // Add a real case to `CROSS_TENANT` or its bounded workflow suite, or say in `UNSCOPED` why there is no tenant to cross.
    expect(unclassified).toEqual([]);
  });

  test('no case outlives its endpoint, and none arrives before it', async () => {
    for (const key of [
      ...Object.keys(CROSS_TENANT),
      ...Object.keys(WORKFLOW_CROSS_TENANT),
      ...Object.keys(UNSCOPED),
    ]) {
      expect({ key, documented: keys.has(key) }).toEqual({ key, documented: true });
    }
    for (const endpoint of documented.filter(
      (each) => endpointKey(each) in CROSS_TENANT || endpointKey(each) in WORKFLOW_CROSS_TENANT,
    )) {
      expect({ key: endpointKey(endpoint), served: await isServed(endpoint) }).toEqual({
        key: endpointKey(endpoint),
        served: true,
      });
    }
  });

  test('stateful crossings stay bounded to the explicit native workspace-security suite', () => {
    const workflows = Object.entries(WORKFLOW_CROSS_TENANT);
    expect(workflows.length).toBe(15);
    for (const [key, crossing] of workflows) {
      expect(
        key === 'GET /api/workspace-security' ||
          /^(GET|POST|PUT|DELETE) \/api\/workspaces\/:workspaceId\/security(?:\/|$)/.test(key),
      ).toBe(true);
      expect(crossing.suite).toBe('workspace-security');
      expect(crossing.testFile).toBe(
        'apps/api/src/ingress/http/workspace-security-cross-tenant.integration.test.ts',
      );
      expect(
        existsSync(fileURLToPath(new URL(`../../../../${crossing.testFile}`, import.meta.url))),
      ).toBe(true);
      expect(crossing.visibility.kind).toBe('none');
      expect(crossing.visibility.reason.length).toBeGreaterThan(0);
      expect(key in UNSCOPED).toBe(false);
      expect(key in CROSS_TENANT).toBe(false);
    }
  });

  test('nothing that names a channel opts out of the visibility axis', () => {
    for (const [key, crossing] of [
      ...Object.entries(CROSS_TENANT),
      ...Object.entries(WORKFLOW_CROSS_TENANT),
    ]) {
      if (key.includes(':channelId')) {
        expect({ key, kind: crossing.visibility.kind }).toEqual({ key, kind: 'channel' });
      }
    }
  });

  test('nothing that names a message opts out of the visibility axis', () => {
    for (const [key, crossing] of [
      ...Object.entries(CROSS_TENANT),
      ...Object.entries(WORKFLOW_CROSS_TENANT),
    ]) {
      if (key.includes(':messageId')) {
        expect({ key, kind: crossing.visibility.kind }).toEqual({ key, kind: 'message' });
      }
    }
  });

  test('the lists of a workspace are found, and a single resource is not one', () => {
    const keys = listEndpoints().map(([key]) => key);
    expect(keys).toContain('GET /api/workspaces/:workspaceId/channels');
    expect(keys).toContain('GET /api/channels/:channelId/messages');
    expect(keys).not.toContain('GET /api/channels/:channelId');
    expect(keys).not.toContain('GET /api/messages/:messageId');
    expect(keys).not.toContain('GET /api/notifications');
    expect(keys.every((key) => key.startsWith('GET '))).toBe(true);
  });

  test('a further query is crossed after the case’s own, joined to it', () => {
    expect(
      queriesFor({
        refusal: 'WORKSPACE_NOT_FOUND',
        alsoWith: { 'an author': 'senderId=:userId' },
        visibility: { kind: 'workspace-wide', query: 'q=question' },
      }),
    ).toEqual([
      ['', '?q=question'],
      [' with an author', '?q=question&senderId=:userId'],
    ]);
    expect(
      queriesFor({
        refusal: 'CHANNEL_NOT_FOUND',
        alsoWith: { 'a limit': 'limit=1' },
        visibility: { kind: 'channel' },
      }),
    ).toEqual([
      ['', ''],
      [' with a limit', '?limit=1'],
    ]);
  });

  test('search and open questions are read as workspace-wide, once they exist', () => {
    // Both must stay documented, or this check would be skipping them by name.
    for (const key of WORKSPACE_WIDE_READS) {
      expect({ key, documented: keys.has(key) }).toEqual({ key, documented: true });
      expect({ key, unscoped: key in UNSCOPED }).toEqual({ key, unscoped: false });
      const crossing = CROSS_TENANT[key];
      if (crossing !== undefined) {
        expect({ key, kind: crossing.visibility.kind }).toEqual({ key, kind: 'workspace-wide' });
      }
    }
  });
});

describe('a list that holds nothing proves nothing', () => {
  test('rows are counted in a bare array and in the arrays of an object, and a single resource has none to count', () => {
    expect(rowsIn([])).toBe(0);
    expect(rowsIn([1, 2])).toBe(2);
    expect(rowsIn({ data: [], nextCursor: null })).toBe(0);
    expect(rowsIn({ data: [1], nextCursor: null })).toBe(1);
    expect(rowsIn({ roots: { data: [1, 2], nextCursor: null }, threads: [] })).toBe(2);
    expect(rowsIn({ roots: { data: [], nextCursor: null }, threads: [] })).toBe(0);
    expect(
      rowsIn({
        roots: { data: [1], nextCursor: null },
        threads: [{ root: { attachments: [1, 2] } }],
      }),
    ).toBe(2);
    expect(rowsIn({ incident: { responders: [] } })).toBeUndefined();
    expect(rowsIn({ usedBytes: 200 })).toBeUndefined();
    expect(rowsIn(null)).toBeUndefined();
  });

  test('the excused lists are no more than their cap, so the list is not a way round the check', () => {
    expect(Object.keys(EMPTY_FOR_THE_SEED).length).toBeLessThanOrEqual(MAX_EMPTY_FOR_THE_SEED);
  });

  test('only a list the seed cannot fill is excused, and only a list is', () => {
    const lists = new Set(listEndpoints().map(([key]) => key));
    for (const [key, reason] of Object.entries(EMPTY_FOR_THE_SEED)) {
      expect({ key, list: lists.has(key), reason: reason.length > 0 }).toEqual({
        key,
        list: true,
        reason: true,
      });
    }
  });
});
