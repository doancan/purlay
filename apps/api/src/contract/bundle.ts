/**
 * The contract bundle (D-192): everything a client that is not the browser's own is generated from and held to,
 * assembled from the places that own it and from nowhere else.
 *
 * A client that is not this code — the macOS application — needs the *facts* this code knows: the shapes on
 * the wire, the routes, the limits, the error codes and what each means, how a message id is made, what a
 * message's markdown comes to, the visual vocabulary. Copying them by hand makes a second home for each; this
 * reads them where they live and writes them down once, with a digest the client pins.
 *
 * - `contract.json` — every named schema of `@purlay/types` as JSON Schema, by the names the contract gives
 *   them; the endpoint table; the constants a client must know; the error codes with their statuses; the
 *   socket's close codes.
 * - `fixtures/` — message-id vectors and the markdown conformance corpus, which a second implementation's tests
 *   run, so that agreement with this code is checked and not assumed.
 * - `tokens.json`, `pairs.json` — the visual values and which colours must be readable against which.
 * - `docs/` — the documents at this version, so references to them can be checked against what the client
 *   was built for.
 * - `MANIFEST.json` — what the bundle is of (server version, contract version, layout version) and a digest of
 *   every file.
 *
 * Deterministic on purpose: the output depends on the repository and on nothing else, so two builds of one
 * commit are one bundle and a digest means something.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Kind, type TSchema } from '@sinclair/typebox';
import * as types from '@purlay/types';
import {
  CONTRACT_BUNDLE_FORMAT,
  CONTRACT_VERSION,
  ENDPOINTS,
  ERROR_STATUS,
  REGISTERED_FORMATS,
  CLOSE_CODES,
  MESSAGE_ID_SKEW,
  isMessageIdShape,
  isPlausibleMessageId,
  messageId,
  type EndpointSpec,
} from '@purlay/types';
import {
  CORPUS,
  MARKDOWN_DELIMITERS_MAX,
  MARKDOWN_DEPTH_MAX,
  MARKDOWN_NESTING_MAX,
  MARKDOWN_RUN_MAX,
  readMarkdown,
  serialiseReading,
} from '@purlay/markdown';
import { EXEMPT, PAIRS } from '@purlay/tokens/pairs';
import { SERVER_VERSION } from '../platform/server-version';

/**
 * The keywords of JSON Schema a schema in the contract may use — the vocabulary the client generator is taught.
 * Widening it is a change to the generator first: `vocabularyProblems` fails the build on a keyword outside,
 * which is the point, since the alternative is a client that quietly ignores a rule the server enforces.
 */
export const SUPPORTED_KEYWORDS: readonly string[] = [
  '$ref',
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'anyOf',
  'const',
  'format',
  'pattern',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minProperties',
  'patternProperties',
  'default',
  'description',
];

/**
 * The constants a client must know, by name. An allowlist, so adding one to the bundle is a reviewed act and not a
 * side effect of exporting it. Each is read from `@purlay/types`, where it is defined.
 */
export const CONSTANTS: readonly string[] = [
  'ACCESS_REVOKED_MAX_CHANNELS',
  'ACK_DEADLINE_MS',
  'ACTIVE_EVERY_MS',
  'ATTACHMENTS_PER_MESSAGE_MAX',
  'ATTACHMENT_BYTES_MAX',
  'ATTACHMENT_PIXELS_MAX',
  'ATTACHMENT_SIDE_MAX',
  'AUTH_BASE_PATH',
  'BACKOFF',
  'CHECK_SESSION_AFTER_FAILURES',
  'CONTRACT_BUNDLE_FORMAT',
  'CONTRACT_VERSION',
  'CONVERSATION_PEOPLE_MAX',
  'DEEP_WORK_MAX_HOURS',
  'ERASURE_SIGN_IN_MINUTES',
  'EXTERNAL_IMAGE_URL_MAX',
  'GITHUB_LINKS_PER_MESSAGE_MAX',
  'INVITATION_TTL_DAYS',
  'MAX_FRAME_BYTES',
  'MESSAGE_CONTENT_MAX',
  'MESSAGE_ID_SKEW',
  'MESSAGE_VERSIONS_KEPT',
  'MESSAGE_WINDOW_SIDE',
  'NATIVE_CHALLENGE_PATTERN',
  'NATIVE_CODE_PATTERN',
  'NATIVE_DEVICE_NAME_PATTERN',
  'NATIVE_REDIRECT',
  'NATIVE_STATE_PATTERN',
  'NATIVE_VERIFIER_PATTERN',
  'NEEDS_YOU',
  'OUTBOX_MAX_CHARS',
  'OUTBOX_MAX_MESSAGES',
  'PAGE_LIMIT',
  'PASSWORD_MAX_LENGTH',
  'PASSWORD_MIN_LENGTH',
  'PENDING_UPLOADS_MAX',
  'PINS_MAX',
  'PING_AFTER_IDLE_MS',
  'PONG_DEADLINE_MS',
  'PRESENCE_GRACE_MS',
  'PROFILE_STATUS_MAX',
  'PROFILE_TITLE_MAX',
  'REPLAY_OVERLAP_MS',
  'REPLAY_RETRY_DELAYS_MS',
  'SAVED_MAX',
  'SEARCH_QUERY_MAX',
  'SEARCH_QUERY_MIN',
  'SIGN_IN_LINK_TTL_MINUTES',
  'SIGN_IN_PATH',
  'STABLE_AFTER_MS',
  'SUBSCRIBE_MAX_CHANNELS',
  'THREAD_EXCERPT_MAX',
  'TOO_BUSY_BACKOFF_STEP',
  'TYPING_TTL_MS',
  'WORKSPACE_NAME_MAX',
];

type Json = null | boolean | number | string | readonly Json[] | { readonly [K in string]: Json };

const isSchema = (value: unknown): value is TSchema =>
  typeof value === 'object' && value !== null && Kind in value;

/** Every named schema of the contract, by object, so a schema met inside another is written as a reference. */
const namedSchemas = (): { byName: Map<string, TSchema>; nameOf: Map<TSchema, string> } => {
  const byName = new Map<string, TSchema>();
  const nameOf = new Map<TSchema, string>();
  for (const [name, value] of Object.entries(types).sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (!isSchema(value)) continue;
    byName.set(name, value);
    // The first name an object is exported under is its name; a second is an alias, written as a reference.
    if (!nameOf.has(value)) nameOf.set(value, name);
  }
  return { byName, nameOf };
};

/** A schema as plain JSON, with a nested named schema written as `{ "$ref": name }`. */
const convert = (value: unknown, nameOf: Map<TSchema, string>, root: TSchema | null): Json => {
  if (isSchema(value) && value !== root) {
    const name = nameOf.get(value);
    if (name !== undefined) return { $ref: name };
  }
  if (Array.isArray(value)) return (value as unknown[]).map((item) => convert(item, nameOf, root));
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, Json> = {};
    // Own string keys only: TypeBox marks its schemas with symbols, which are not the contract's.
    for (const [key, inner] of Object.entries(value)) {
      if (inner === undefined) continue;
      out[key] = convert(inner, nameOf, root);
    }
    return out;
  }
  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
    throw new Error(`a ${typeof value} reached the contract; a schema may carry only data`);
  }
  return value as Json;
};

interface EndpointJson {
  readonly id: string;
  readonly method: string;
  readonly path: string;
  readonly auth: 'session' | 'none';
  readonly query?: Json;
  readonly body?: Json;
  readonly responses: Readonly<Record<string, Json>>;
}

export interface Contract {
  readonly format: number;
  readonly contractVersion: number;
  readonly schemas: Readonly<Record<string, Json>>;
  readonly endpoints: readonly EndpointJson[];
  readonly constants: Readonly<Record<string, Json>>;
  readonly errorStatus: Readonly<Record<string, number>>;
  readonly closeCodes: Readonly<Record<string, number>>;
  readonly formats: readonly string[];
}

export const buildContract = (): Contract => {
  const { byName, nameOf } = namedSchemas();

  const schemas: Record<string, Json> = {};
  for (const [name, schema] of byName) {
    // An alias of another name is that name, by reference: one schema, two spellings.
    const canonical = nameOf.get(schema);
    schemas[name] =
      canonical !== undefined && canonical !== name
        ? { $ref: canonical }
        : convert(schema, nameOf, schema);
  }

  const asJson = (schema: TSchema): Json => convert(schema, nameOf, null);
  const endpoints: EndpointJson[] = (ENDPOINTS as readonly EndpointSpec[]).map((entry) => {
    const responses: Record<string, Json> = {};
    for (const [status, response] of Object.entries(entry.responses)) {
      responses[status] = response === null || response === 'binary' ? response : asJson(response);
    }
    return {
      id: entry.id,
      method: entry.method,
      path: entry.path,
      auth: entry.auth,
      ...(entry.query === undefined ? {} : { query: asJson(entry.query) }),
      ...(entry.body === undefined
        ? {}
        : { body: entry.body === 'octet-stream' ? entry.body : asJson(entry.body) }),
      responses,
    };
  });

  const constants: Record<string, Json> = {};
  const exported = types as unknown as Record<string, unknown>;
  for (const name of [...CONSTANTS].sort()) {
    const value = exported[name];
    if (value === undefined)
      throw new Error(`the constant ${name} is not exported by @purlay/types`);
    constants[name] = convert(value, nameOf, null);
  }

  return {
    format: CONTRACT_BUNDLE_FORMAT,
    contractVersion: CONTRACT_VERSION,
    schemas,
    endpoints,
    constants,
    errorStatus: { ...ERROR_STATUS },
    closeCodes: { ...CLOSE_CODES },
    formats: [...REGISTERED_FORMATS],
  };
};

/**
 * Where a schema uses a keyword outside the vocabulary, as `<where>: <keyword>`. Walks schemas as schemas — a
 * property's name is not a keyword, a `const` is data — so what it reports is what a generator would meet.
 */
export const vocabularyProblems = (contract: Contract): string[] => {
  const allowed = new Set(SUPPORTED_KEYWORDS);
  const problems: string[] = [];
  const walk = (schema: unknown, where: string): void => {
    if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) return;
    const record = schema as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (!allowed.has(key)) problems.push(`${where}: ${key}`);
    }
    const properties = record['properties'];
    if (typeof properties === 'object' && properties !== null) {
      for (const inner of Object.values(properties)) walk(inner, where);
    }
    const patterns = record['patternProperties'];
    if (typeof patterns === 'object' && patterns !== null) {
      for (const inner of Object.values(patterns)) walk(inner, where);
    }
    const items = record['items'];
    if (items !== undefined) walk(items, where);
    const extra = record['additionalProperties'];
    if (typeof extra === 'object') walk(extra, where);
    const anyOf = record['anyOf'];
    if (Array.isArray(anyOf)) for (const inner of anyOf) walk(inner, where);
  };
  for (const [name, schema] of Object.entries(contract.schemas)) walk(schema, name);
  for (const entry of contract.endpoints) {
    for (const part of [entry.query, entry.body, ...Object.values<Json>(entry.responses)]) {
      if (typeof part === 'object') walk(part, entry.id);
    }
  }
  return [...new Set(problems)];
};

// ── Fixtures

/** Ten bytes of randomness, repeating `seed`: a client given the same bytes must make the same id. */
const bytesOf =
  (seed: number) =>
  (bytes: Uint8Array): void => {
    for (let at = 0; at < bytes.length; at += 1) bytes[at] = (seed + at * 17) & 0xff;
  };

export interface MessageIdVectors {
  readonly note: string;
  readonly skew: typeof MESSAGE_ID_SKEW;
  readonly generated: readonly { timestampMs: number; randomHex: string; id: string }[];
  readonly shape: readonly { value: string; valid: boolean; why: string }[];
  readonly plausibility: readonly {
    nowMs: number;
    id: string;
    offsetMs: number;
    plausible: boolean;
  }[];
}

export const buildMessageIdVectors = (): MessageIdVectors => {
  const generated: { timestampMs: number; randomHex: string; id: string }[] = [];
  for (const timestampMs of [
    0, 1, 1_000, 65_535, 65_536, 1_700_000_000_000, 1_795_608_000_000, 0xffff_ffff_ffff,
  ]) {
    for (const seed of [0, 0x5a, 0xff]) {
      const random = new Uint8Array(10);
      bytesOf(seed)(random);
      generated.push({
        timestampMs,
        randomHex: [...random].map((byte) => byte.toString(16).padStart(2, '0')).join(''),
        id: messageId(new Date(timestampMs), bytesOf(seed)),
      });
    }
  }

  const good = messageId(new Date(1_795_608_000_000), bytesOf(0x5a));
  const shapes: { value: string; why: string }[] = [
    { value: good, why: 'a version 7 id, lower case' },
    { value: '00000000-0000-7000-8000-000000000000', why: 'the lowest' },
    { value: 'ffffffff-ffff-7fff-bfff-ffffffffffff', why: 'the highest' },
    { value: good.toUpperCase(), why: 'upper case: ids are compared as text' },
    { value: `${good.slice(0, 14)}4${good.slice(15)}`, why: 'version 4, not 7' },
    { value: `${good.slice(0, 14)}1${good.slice(15)}`, why: 'version 1, not 7' },
    { value: `${good.slice(0, 19)}c${good.slice(20)}`, why: 'variant bits 11, not 10' },
    { value: `${good.slice(0, 19)}7${good.slice(20)}`, why: 'variant bits 01, not 10' },
    { value: good.slice(1), why: 'one character short' },
    { value: `${good}0`, why: 'one character long' },
    { value: good.replaceAll('-', ''), why: 'no hyphens' },
    { value: `${good.slice(0, 35)}g`, why: 'a character that is not hex' },
    { value: ` ${good}`, why: 'leading space' },
    { value: `${good}\n`, why: 'trailing newline' },
    { value: `{${good}}`, why: 'braces' },
    { value: '', why: 'empty' },
  ];
  const shape = shapes.map(({ value, why }) => ({ value, valid: isMessageIdShape(value), why }));

  const nowMs = 1_795_608_000_000;
  const plausibility: { nowMs: number; id: string; offsetMs: number; plausible: boolean }[] = [];
  for (const offsetMs of [
    -MESSAGE_ID_SKEW.behindMs - 1,
    -MESSAGE_ID_SKEW.behindMs,
    -MESSAGE_ID_SKEW.behindMs + 1,
    -1,
    0,
    1,
    MESSAGE_ID_SKEW.aheadMs - 1,
    MESSAGE_ID_SKEW.aheadMs,
    MESSAGE_ID_SKEW.aheadMs + 1,
    -3_600_000,
    3_600_000,
  ]) {
    const id = messageId(new Date(nowMs + offsetMs), bytesOf(0x5a));
    plausibility.push({
      nowMs,
      id,
      offsetMs,
      plausible: isPlausibleMessageId(id, new Date(nowMs)),
    });
  }

  return {
    note:
      'generated: the id `messageId(timestampMs, randomHex)` makes — 48 bits of time, version 7, variant 10, then the ' +
      'random bytes. shape: `isMessageIdShape`. plausibility: `isPlausibleMessageId(id, now)` — a client generates ' +
      "ids from the clock corrected by the server's, and an id outside the window is refused (D-33).",
    skew: MESSAGE_ID_SKEW,
    generated,
    shape,
    plausibility,
  };
};

export interface MarkdownCorpusFile {
  readonly format: number;
  readonly note: string;
  readonly limits: {
    readonly depthMax: number;
    readonly delimitersMax: number;
    readonly nestingMax: number;
    readonly runMax: number;
  };
  readonly cases: readonly { name: string; input: string; expected: Json }[];
}

export const buildMarkdownCorpus = (): MarkdownCorpusFile => ({
  format: 1,
  note:
    'expected: the narrowed tree `readMarkdown(input)` gives (`packages/markdown/src/tree.ts`), or `{ tree: null, reason }` ' +
    "for a body shown as typed. A link's `url` is the string the WHATWG URL parser makes of the address — host lower-" +
    'cased, an empty path `/`, default port dropped — which is not always the characters typed: a client compares ' +
    'addresses by their parts, or normalises as that parser does, never by the typed text. `reason: engine` never appears ' +
    '(a defect), and `limits` are the bounds the reasons come from.',
  limits: {
    depthMax: MARKDOWN_DEPTH_MAX,
    delimitersMax: MARKDOWN_DELIMITERS_MAX,
    nestingMax: MARKDOWN_NESTING_MAX,
    runMax: MARKDOWN_RUN_MAX,
  },
  cases: CORPUS.map((entry) => ({
    name: entry.name,
    input: entry.input,
    expected: serialiseReading(readMarkdown(entry.input)) as Json,
  })),
});

// ── Assembly

const README = `# Purlay contract bundle

What a client that is not the browser's own is generated from and held to (\`DECISIONS.md\` D-186, D-192). One
bundle is one server version; \`MANIFEST.json\` says which, with a \`sha256\` of every file. A client pins the
bundle by the digest of \`MANIFEST.json\` and refuses a file whose digest is not the one listed.

- \`contract.json\` — \`schemas\` (JSON Schema, by name; a nested named schema is \`{ "$ref": "<name>" }\`, and a
  keyword outside the supported vocabulary is a build failure of the server), \`endpoints\` (id, method, path
  template, who may call, the query and body schemas and the successful responses; a failure is always the one
  error envelope), \`constants\`, \`errorStatus\` (every error \`code\` and the HTTP status it is answered with),
  \`closeCodes\` (the socket's application close codes) and \`formats\` (the string formats a schema names).
- \`fixtures/message-ids.json\` — ids a client must be able to make and recognise, and the plausibility window.
- \`fixtures/markdown-corpus.json\` — inputs and the narrowed tree the server's engine reads from each. A client
  with its own parser passes when it produces the same tree; every divergence is a defect to resolve or to record.
- \`tokens.json\`, \`pairs.json\` — the visual values, and which colours must be readable against which and by how much.
- \`docs/\` — the documents at this version, for checking references against what the client was built for.

Unknown things are ignored, not failed: a response may gain a field, an enum may gain a value, a union may gain a
member. What the server refuses from a client is closed (a request body may carry only what its schema declares).
`;

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

const DOCUMENTS = ['UX.md', 'API.md', 'ARCHITECTURE.md', 'DECISIONS.md'] as const;

/** The bundle, as path → text, for the repository at `root`. */
export const assembleBundle = (root: string): Map<string, string> => {
  const files = new Map<string, string>();
  files.set('README.md', README);
  files.set('contract.json', json(buildContract()));
  files.set('tokens.json', readFileSync(join(root, 'packages/tokens/tokens.json'), 'utf8'));
  files.set('pairs.json', json({ format: 1, pairs: PAIRS, exempt: EXEMPT }));
  files.set('fixtures/message-ids.json', json(buildMessageIdVectors()));
  files.set('fixtures/markdown-corpus.json', json(buildMarkdownCorpus()));
  for (const document of DOCUMENTS) {
    files.set(`docs/${document}`, readFileSync(join(root, 'docs', document), 'utf8'));
  }

  const listed = [...files.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([path, text]) => ({ path, sha256: createHash('sha256').update(text).digest('hex') }));
  const manifest = {
    format: CONTRACT_BUNDLE_FORMAT,
    serverVersion: SERVER_VERSION,
    contractVersion: CONTRACT_VERSION,
    files: listed,
  };
  const out = new Map<string, string>();
  out.set('MANIFEST.json', json(manifest));
  for (const { path } of listed) out.set(path, files.get(path) ?? '');
  return out;
};
