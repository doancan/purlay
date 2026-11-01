/**
 * The contract bundle (D-192): what the macOS application is generated from, and the one thing it has to be
 * able to trust — that it is the contract, whole, and says so itself.
 *
 * The client is generated; what it generates *from* is checked here, so the checks live on the side that owns
 * the facts. The vocabulary a schema may use is the interface to the generator: widening it is a change the
 * generator has to be taught, and this test is where that is decided rather than discovered.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import {
  CONTRACT_BUNDLE_FORMAT,
  CONTRACT_VERSION,
  ENDPOINTS,
  ERROR_STATUS,
  type EndpointSpec,
} from '@purlay/types';
import { CORPUS } from '@purlay/markdown';
import { SERVER_VERSION } from '../platform/server-version';
import {
  CONSTANTS,
  SUPPORTED_KEYWORDS,
  assembleBundle,
  buildContract,
  buildMarkdownCorpus,
  buildMessageIdVectors,
  vocabularyProblems,
} from './bundle';

const contract = buildContract();

const refsIn = (value: unknown, found = new Set<string>()): Set<string> => {
  if (Array.isArray(value)) value.forEach((item) => refsIn(item, found));
  else if (typeof value === 'object' && value !== null) {
    for (const [key, inner] of Object.entries(value)) {
      if (key === '$ref' && typeof inner === 'string') found.add(inner);
      else refsIn(inner, found);
    }
  }
  return found;
};

describe('the contract', () => {
  test('says what it is, and which contract', () => {
    expect(contract.format).toBe(CONTRACT_BUNDLE_FORMAT);
    expect(contract.contractVersion).toBe(CONTRACT_VERSION);
  });

  test('carries the schemas a client needs, by the names the contract gives them', () => {
    for (const name of [
      'Message',
      'MessagePage',
      'MeResponse',
      'Channel',
      'ClientInfo',
      'ClientFrame',
      'ServerFrame',
      'ErrorResponse',
      'ErrorCode',
      'Attachment',
      'NativeTokenRequest',
    ]) {
      expect(Object.keys(contract.schemas)).toContain(name);
    }
    expect(Object.keys(contract.schemas).length).toBeGreaterThan(150);
  });

  test('names what a schema is made of rather than repeating it: a page of messages holds the message by reference', () => {
    const page = JSON.stringify(contract.schemas['MessagePage']);
    expect(page).toContain('"$ref":"Message"');
    expect(page).not.toContain('"githubEvent"');
  });

  test('publishes the inbox CSV filter and its validation in the existing generator vocabulary', () => {
    expect(
      contract.endpoints.find((endpoint) => endpoint.id === 'listNotifications')?.query,
    ).toEqual({ $ref: 'NotificationQuery' });
    expect(contract.schemas['NotificationQuery']).toMatchObject({
      properties: { types: contract.schemas['NotificationTypesFilter'] },
      required: ['workspaceId'],
    });
    expect(contract.schemas['NotificationTypesFilter']).toMatchObject({
      type: 'string',
      minLength: 1,
    });
    expect(JSON.stringify(contract.schemas['NotificationTypesFilter'])).toContain('\"pattern\":\"');
    expect(vocabularyProblems(contract)).toEqual([]);
    const serialized = JSON.stringify(buildContract());
    expect(JSON.stringify(buildContract())).toBe(serialized);
  });

  test('carries optional additive capabilities without a contract or bundle-layout bump', () => {
    expect(contract.schemas['ClientInfo']).toMatchObject({
      properties: {
        capabilities: { properties: { notificationTypeFilters: { type: 'boolean' } } },
      },
    });
    expect(JSON.stringify(contract.schemas['ClientCapabilities'])).toContain(
      'notificationTypeFilters',
    );
    const schema = contract.schemas['ClientInfo'] as { required?: readonly string[] };
    expect(schema.required ?? []).not.toContain('capabilities');
    expect(contract.contractVersion).toBe(CONTRACT_VERSION);
    expect(contract.format).toBe(CONTRACT_BUNDLE_FORMAT);
  });

  test('is closed: every reference resolves to a schema of the contract', () => {
    const names = new Set(Object.keys(contract.schemas));
    const dangling = [...refsIn(contract)].filter((name) => !names.has(name));
    expect(dangling).toEqual([]);
    // The positive condition: there are references at all, so this is not a scan of nothing.
    expect(refsIn(contract).size).toBeGreaterThan(50);
  });

  test('speaks only the vocabulary the generator is taught', () => {
    expect(vocabularyProblems(contract)).toEqual([]);
    expect(SUPPORTED_KEYWORDS.length).toBeGreaterThan(10);
  });

  test('sees a keyword outside the vocabulary when there is one', () => {
    const problems = vocabularyProblems({
      ...contract,
      schemas: { Odd: { type: 'string', pattern: 'x', allOf: [{ type: 'string' }] } },
      endpoints: [],
    });
    expect(problems).toEqual(['Odd: allOf']);
  });

  test.each([
    ['a property', { type: 'object', properties: { a: { type: 'string', allOf: [] } } }],
    ['an item', { type: 'array', items: { type: 'string', not: {} } }],
    ['a union member', { anyOf: [{ type: 'string' }, { type: 'string', oneOf: [] }] }],
    [
      'an open object’s values',
      { type: 'object', additionalProperties: { type: 'string', $defs: {} } },
    ],
    [
      'a pattern property',
      { type: 'object', patternProperties: { '^x': { type: 'string', not: {} } } },
    ],
  ])('sees a keyword outside the vocabulary under %s', (_where, schema) => {
    expect(
      vocabularyProblems({ ...contract, schemas: { Odd: schema }, endpoints: [] }),
    ).toHaveLength(1);
  });

  test('sees one in an endpoint’s query, body and responses, named by the endpoint', () => {
    const odd = { type: 'string', allOf: [] } as never;
    const problems = vocabularyProblems({
      ...contract,
      schemas: {},
      endpoints: [
        { id: 'q', method: 'GET', path: '/q', auth: 'none', query: odd, responses: {} },
        { id: 'b', method: 'POST', path: '/b', auth: 'none', body: odd, responses: {} },
        { id: 'r', method: 'GET', path: '/r', auth: 'none', responses: { '200': odd } },
      ],
    });
    expect(problems.sort()).toEqual(['b: allOf', 'q: allOf', 'r: allOf']);
  });

  test('leaks nothing a client cannot read: no symbol, no function, no undefined', () => {
    const text = JSON.stringify(contract);
    expect(JSON.parse(text)).toEqual(contract);
    expect(text).not.toContain('Symbol(');
  });

  test('marks an optional field as optional, and a nullable one as nullable', () => {
    const message = contract.schemas['Message'] as {
      required: string[];
      properties: Record<string, unknown>;
    };
    expect(message.required).toContain('id');
    expect(message.required).toContain('parentId');
    // `parentId` is `Uuid | null`: required, and nullable.
    expect(JSON.stringify(message.properties['parentId'])).toContain('"type":"null"');
    const query = contract.schemas['PageQuery'] as { required?: string[] };
    expect(query.required ?? []).not.toContain('before');
  });

  test('is the same when built again, in the same order: a bundle is something two builds can be compared by', () => {
    expect(JSON.stringify(buildContract())).toBe(JSON.stringify(contract));
    expect(Object.keys(contract.schemas)).toEqual([...Object.keys(contract.schemas)].sort());
  });
});

describe('the endpoints in the contract', () => {
  test('are the table, entry for entry', () => {
    expect(contract.endpoints.map((entry) => entry.id)).toEqual(
      (ENDPOINTS as readonly EndpointSpec[]).map((entry) => entry.id),
    );
  });

  test('refer to schemas by name, so a client names what it sends and receives', () => {
    const send = contract.endpoints.find((entry) => entry.id === 'sendMessage');
    expect(send?.body).toEqual({ $ref: 'SendMessageRequest' });
    expect(send?.responses['201']).toEqual({ $ref: 'Message' });
    const list = contract.endpoints.find((entry) => entry.id === 'listMessages');
    expect(list?.query).toEqual({ $ref: 'PageQuery' });
    const channels = contract.endpoints.find((entry) => entry.id === 'listChannels');
    expect(channels?.responses['200']).toEqual({ $ref: 'ChannelList' });
  });

  test('say which have no body, and which are bytes', () => {
    const logout = contract.endpoints.find((entry) => entry.id === 'logout');
    expect(logout?.responses['204']).toBeNull();
    const upload = contract.endpoints.find((entry) => entry.id === 'uploadFile');
    expect(upload?.body).toBe('octet-stream');
    const download = contract.endpoints.find((entry) => entry.id === 'downloadAttachment');
    expect(download?.responses['200']).toBe('binary');
  });

  test('say who may call: the session, or nobody yet', () => {
    expect(contract.endpoints.find((entry) => entry.id === 'getClientInfo')?.auth).toBe('none');
    expect(contract.endpoints.find((entry) => entry.id === 'getMe')?.auth).toBe('session');
  });
});

describe('the constants in the contract', () => {
  test('are named, one by one, and each is a value the contract defines', () => {
    expect(Object.keys(contract.constants).sort()).toEqual([...CONSTANTS].sort());
    for (const name of CONSTANTS) expect(contract.constants[name]).not.toBeUndefined();
  });

  test('include what a client needs to speak the protocol', () => {
    for (const name of [
      'ACK_DEADLINE_MS',
      'BACKOFF',
      'MAX_FRAME_BYTES',
      'SUBSCRIBE_MAX_CHANNELS',
      'MESSAGE_ID_SKEW',
      'REPLAY_OVERLAP_MS',
      'MESSAGE_CONTENT_MAX',
      'ATTACHMENT_BYTES_MAX',
      'NEEDS_YOU',
      'NATIVE_REDIRECT',
      'PAGE_LIMIT',
      'OUTBOX_MAX_MESSAGES',
    ]) {
      expect(Object.keys(contract.constants)).toContain(name);
    }
  });

  test('carry the error codes with the status each is answered with, and the socket’s close codes', () => {
    expect(contract.errorStatus).toEqual({ ...ERROR_STATUS });
    expect(contract.errorStatus['CLIENT_TOO_OLD']).toBe(426);
    expect(contract.closeCodes['SESSION_ENDED']).toBe(4401);
    expect(contract.closeCodes['RESTARTING']).toBe(1012);
  });
});

describe('the message-id vectors', () => {
  const vectors = buildMessageIdVectors();

  test('hold ids made at known instants, with the time each carries', () => {
    expect(vectors.generated.length).toBeGreaterThanOrEqual(5);
    for (const vector of vectors.generated) {
      expect(vector.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(parseInt(vector.id.slice(0, 8) + vector.id.slice(9, 13), 16)).toBe(vector.timestampMs);
    }
  });

  test('hold the shapes a client must refuse, each with the reason', () => {
    const refused = vectors.shape.filter((vector) => !vector.valid);
    expect(refused.length).toBeGreaterThanOrEqual(8);
    expect(vectors.shape.some((vector) => vector.valid)).toBe(true);
  });

  test('hold the window: plausible just inside it on both sides, and not a millisecond outside', () => {
    const inside = vectors.plausibility.filter((vector) => vector.plausible);
    const outside = vectors.plausibility.filter((vector) => !vector.plausible);
    expect(inside.length).toBeGreaterThanOrEqual(4);
    expect(outside.length).toBeGreaterThanOrEqual(4);
    expect(vectors.skew).toEqual({ behindMs: 60_000, aheadMs: 5_000 });
  });
});

describe('the markdown corpus in the bundle', () => {
  const file = buildMarkdownCorpus();

  test('is every case, with the reading the engine gives it', () => {
    expect(file.cases.map((entry) => entry.name)).toEqual(CORPUS.map((entry) => entry.name));
    for (const entry of file.cases) expect(entry.expected).toBeDefined();
  });

  test('says what its addresses are: the engine’s own spelling, which a client compares by parts', () => {
    expect(file.note).toContain('WHATWG');
  });
});

describe('the assembled bundle', () => {
  const bundle = assembleBundle('.');

  test('has what a client is generated from, and what its tests are held to', () => {
    for (const path of [
      'MANIFEST.json',
      'README.md',
      'contract.json',
      'tokens.json',
      'pairs.json',
      'fixtures/message-ids.json',
      'fixtures/markdown-corpus.json',
      'docs/UX.md',
      'docs/API.md',
      'docs/ARCHITECTURE.md',
      'docs/DECISIONS.md',
    ]) {
      expect([...bundle.keys()]).toContain(path);
    }
  });

  test('lists every file in its manifest with the digest of the file, and says what it is a bundle of', () => {
    const manifest = JSON.parse(String(bundle.get('MANIFEST.json'))) as {
      format: number;
      serverVersion: string;
      contractVersion: number;
      files: { path: string; sha256: string }[];
    };
    expect(manifest.format).toBe(CONTRACT_BUNDLE_FORMAT);
    expect(manifest.serverVersion).toBe(SERVER_VERSION);
    expect(manifest.contractVersion).toBe(CONTRACT_VERSION);
    // In path order, as written: a manifest that follows declaration order is not one two builds agree on.
    const written = manifest.files.map((entry) => entry.path);
    expect(written).toEqual(written.slice().sort());
    const listed = written.slice().sort();
    const present = [...bundle.keys()].filter((path) => path !== 'MANIFEST.json').sort();
    expect(listed).toEqual(present);
    for (const entry of manifest.files) {
      const text = bundle.get(entry.path);
      expect(
        createHash('sha256')
          .update(text ?? '')
          .digest('hex'),
      ).toBe(entry.sha256);
    }
  });

  test('carries the tokens as they are: the file is the file', () => {
    expect(bundle.get('tokens.json')).toBe(readFileSync('packages/tokens/tokens.json', 'utf8'));
  });

  test('carries the documents as they are, so references to them can be checked against what the client was built for', () => {
    expect(bundle.get('docs/UX.md')).toBe(readFileSync('docs/UX.md', 'utf8'));
  });

  test('holds the pairs of colours that must be readable, by token name', () => {
    const pairs = JSON.parse(String(bundle.get('pairs.json'))) as {
      pairs: { foreground: string; minimum: number }[];
    };
    expect(pairs.pairs.length).toBeGreaterThan(20);
    // 3 and 4.5 are WCAG's; 1.6 is the one named softer edge of a control (D-247).
    expect(pairs.pairs.every((pair) => [1.6, 3, 4.5].includes(pair.minimum))).toBe(true);
  });

  test('is never assembled from a contract the generator is not taught: it throws, naming the keyword', () => {
    const odd = { ...contract, schemas: { Odd: { type: 'string', allOf: [] } as never } };
    expect(() => assembleBundle('.', odd)).toThrow('Odd: allOf');
  });

  test('is the same when assembled again: two builds of one commit are one bundle', () => {
    const again = assembleBundle('.');
    expect([...again.entries()]).toEqual([...bundle.entries()]);
  });

  test('says in its README what to read it with, and that the macOS application pins one by digest', () => {
    const readme = String(bundle.get('README.md'));
    expect(readme).toContain('contract.json');
    expect(readme).toContain('sha256');
    expect(readme).toContain('$ref');
  });
});
