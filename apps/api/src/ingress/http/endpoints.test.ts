/**
 * The endpoint table is bound to both truths (D-192, `OVERVIEW.md`): the routes the server registers, and the
 * rows `API.md` publishes. An entry nobody serves, or nobody documents, is a lie a generated client would
 * make a method of; a route the table lacks is simply one the macOS application cannot call yet — it cannot
 * be spelled by a client generated from the table.
 *
 * This is a mechanism, not a copy: `enforcement.test.ts` already compares `API.md` with the routes for the
 * phase-0 rows; this holds the table to the same two.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { Kind, type TSchema } from '@sinclair/typebox';
import * as types from '@purlay/types';
import { ENDPOINTS, type EndpointSpec } from '@purlay/types';

const appSource = readFileSync('apps/api/src/ingress/http/app.ts', 'utf8');

/** `METHOD /path` for every route the application registers, as a link of its chain. */
const served = new Set(
  [...appSource.matchAll(/^\s*\.(get|post|put|patch|delete)\(\s*'([^']+)'/gm)].map(
    (match) => `${(match[1] ?? '').toUpperCase()} ${match[2] ?? ''}`,
  ),
);

/** `METHOD /path` for every row of `API.md`, as the document spells it. */
const documented = new Set(
  readFileSync('docs/API.md', 'utf8')
    .split('\n')
    .map((line) => line.split('|').map((cell) => cell.trim()))
    .filter((cells) => cells.length > 4 && cells[1] === '○')
    .map(
      (cells) => `${(cells[2] ?? '').replaceAll('`', '')} ${(cells[3] ?? '').replaceAll('`', '')}`,
    ),
);

const named = new Set(
  Object.entries(types)
    .filter(([, value]) => typeof value === 'object' && Kind in (value as Record<symbol, unknown>))
    .map(([name]) => name),
);

const schemasOf = (endpoint: EndpointSpec): readonly TSchema[] => [
  ...(endpoint.query === undefined ? [] : [endpoint.query]),
  ...(endpoint.body === undefined || endpoint.body === 'octet-stream' ? [] : [endpoint.body]),
  ...Object.values(endpoint.responses).filter(
    (response): response is TSchema => response !== null && response !== 'binary',
  ),
];

describe('the endpoint table', () => {
  test('both sides were read, so this is not a comparison of two empty lists', () => {
    expect(ENDPOINTS.length).toBeGreaterThan(40);
    expect(served.size).toBeGreaterThan(40);
    expect(documented.size).toBeGreaterThan(40);
    expect(named.size).toBeGreaterThan(100);
  });

  test('every entry is a route the application registers, spelled as it spells it', () => {
    const missing = ENDPOINTS.map((e) => `${e.method} ${e.path}`).filter(
      (route) => !served.has(route),
    );
    expect(missing).toEqual([]);
  });

  test('every entry is a row of API.md', () => {
    const missing = ENDPOINTS.map((e) => `${e.method} ${e.path}`).filter(
      (route) => !documented.has(route),
    );
    expect(missing).toEqual([]);
  });

  test('every id is one word in lower camel case, and each is used once', () => {
    const ids = ENDPOINTS.map((e) => e.id);
    expect(ids.filter((id) => !/^[a-z][A-Za-z0-9]*$/.test(id))).toEqual([]);
    expect(ids.filter((id, at) => ids.indexOf(id) !== at)).toEqual([]);
  });

  test('every route is in the table once', () => {
    const routes = ENDPOINTS.map((e) => `${e.method} ${e.path}`);
    expect(routes.filter((route, at) => routes.indexOf(route) !== at)).toEqual([]);
  });

  test('every schema an entry names is one the contract exports, so a client can give it a name', () => {
    const anonymous: string[] = [];
    for (const endpoint of ENDPOINTS) {
      for (const schema of schemasOf(endpoint)) {
        const known = Object.entries(types).some(([, value]) => value === schema);
        // An array of a named schema is the one anonymous shape a response may be.
        const items = (schema as { items?: TSchema }).items;
        const itemsKnown =
          items !== undefined && Object.entries(types).some(([, value]) => value === items);
        if (!known && !itemsKnown)
          anonymous.push(`${endpoint.id}: ${JSON.stringify(schema).slice(0, 60)}`);
      }
    }
    expect(anonymous).toEqual([]);
  });

  test('every path parameter is named in the camel case the router uses, and every one is declared by the path', () => {
    for (const endpoint of ENDPOINTS) {
      const names = [...endpoint.path.matchAll(/:([A-Za-z]+)/g)].map((match) => match[1] ?? '');
      expect(names.filter((name) => !/^[a-z][A-Za-z]*$/.test(name))).toEqual([]);
    }
  });

  test('a request that has a body says what kind, and a read has none', () => {
    for (const endpoint of ENDPOINTS as readonly EndpointSpec[]) {
      if (endpoint.method === 'GET' || endpoint.method === 'DELETE') {
        expect({ id: endpoint.id, body: endpoint.body }).toEqual({
          id: endpoint.id,
          body: undefined,
        });
      }
    }
  });

  test('a route that needs no session is one of the few that is public, and says so', () => {
    const publicIds = ENDPOINTS.filter((e) => e.auth === 'none').map((e) => e.id);
    expect(publicIds.sort()).toEqual(['getAuthMethods', 'getClientInfo', 'nativeToken']);
  });

  test('every response is a success: the failures are the one envelope, and are not repeated per route', () => {
    for (const endpoint of ENDPOINTS) {
      const statuses = Object.keys(endpoint.responses).map(Number);
      expect(statuses.length).toBeGreaterThan(0);
      expect(statuses.filter((status) => status < 200 || status > 299)).toEqual([]);
    }
  });
});
