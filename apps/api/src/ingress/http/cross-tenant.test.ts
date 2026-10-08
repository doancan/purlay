/**
 * An endpoint cannot be served without a cross-tenant case, or the build fails.
 *
 * Runs without a database, in `bun run verify`, so the omission is caught before
 * the integration job is reached. The crossings themselves are in
 * `cross-tenant.integration.test.ts`. (D-21, D-63)
 */
import { describe, expect, test } from 'bun:test';
import { createApp } from './app';
import {
  CROSS_TENANT,
  UNSCOPED,
  documentedEndpoints,
  endpointKey,
  type DocumentedEndpoint,
} from './cross-tenant';
import { testDependencies } from './testing';

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

describe('every served endpoint has a cross-tenant case', () => {
  const documented = documentedEndpoints();
  const keys = new Set(documented.map(endpointKey));

  test('the endpoint tables are actually being read', () => {
    // A parser that matched nothing would make every assertion below vacuous.
    expect(keys.has('GET /api/me')).toBe(true);
    expect(keys.has('GET /api/channels/:channelId/messages')).toBe(true);
    expect(keys.has('POST /api/webhooks/github')).toBe(true);
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
});
