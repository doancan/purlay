/**
 * An endpoint cannot be served without a cross-tenant case, or the build fails.
 *
 * Runs without a database, in `bun run verify`, so the omission is caught before
 * the integration job is reached. The crossings themselves are in
 * `cross-tenant.integration.test.ts`. (D-21, D-63)
 */
import { tmpdir } from 'node:os';
import { describe, expect, test } from 'bun:test';
import { createApp } from '../ingress/http/app';
import {
  CROSS_TENANT,
  UNSCOPED,
  WORKSPACE_WIDE_READS,
  documentedEndpoints,
  endpointKey,
  queriesFor,
  type DocumentedEndpoint,
} from './cross-tenant';
import { testDependencies } from './doubles';

const SOME_ID = '00000000-0000-4000-8000-000000000000';

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
      const inUnscoped = key in UNSCOPED;
      expect({ key, both: inCases && inUnscoped }).toEqual({ key, both: false });
      if (!inCases && !inUnscoped && (await isServed(endpoint))) unclassified.push(key);
    }
    // Add a case to `CROSS_TENANT`, or say in `UNSCOPED` why there is no tenant to cross.
    expect(unclassified).toEqual([]);
  });

  test('no case outlives its endpoint, and none arrives before it', async () => {
    for (const key of [...Object.keys(CROSS_TENANT), ...Object.keys(UNSCOPED)]) {
      expect({ key, documented: keys.has(key) }).toEqual({ key, documented: true });
    }
    for (const endpoint of documented.filter((each) => endpointKey(each) in CROSS_TENANT)) {
      expect({ key: endpointKey(endpoint), served: await isServed(endpoint) }).toEqual({
        key: endpointKey(endpoint),
        served: true,
      });
    }
  });

  test('nothing that names a channel opts out of the visibility axis', () => {
    for (const [key, crossing] of Object.entries(CROSS_TENANT)) {
      if (key.includes(':channelId')) {
        expect({ key, kind: crossing.visibility.kind }).toEqual({ key, kind: 'channel' });
      }
    }
  });

  test('nothing that names a message opts out of the visibility axis', () => {
    for (const [key, crossing] of Object.entries(CROSS_TENANT)) {
      if (key.includes(':messageId')) {
        expect({ key, kind: crossing.visibility.kind }).toEqual({ key, kind: 'message' });
      }
    }
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
