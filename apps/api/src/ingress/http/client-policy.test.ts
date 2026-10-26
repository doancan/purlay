import { describe, expect, test } from 'bun:test';
import {
  clientRefusal,
  compareVersions,
  isOutsideClientPolicy,
  parseClientHeader,
  type ClientPolicy,
} from './client-policy';

const policy = (overrides: Partial<ClientPolicy['macos']> = {}): ClientPolicy => ({
  macos: { contract: null, version: null, downloadUrl: null, ...overrides },
});

describe('the client header', () => {
  test('names the platform, the app version and the contract it was built against', () => {
    expect(parseClientHeader('macos/1.4.2 contract/3')).toEqual({
      platform: 'macos',
      version: '1.4.2',
      contract: 3,
    });
  });

  test('a pre-release version is a version', () => {
    expect(parseClientHeader('macos/1.4.2-rc.1 contract/3')?.version).toBe('1.4.2-rc.1');
  });

  // A browser sends none, and a typo must never lock a person out (S2): whatever is not exactly the
  // shape is no client at all, which the server lets through.
  test.each([
    ['nothing', null],
    ['empty', ''],
    ['only a platform', 'macos'],
    ['no contract', 'macos/1.0.0'],
    ['a contract that is not a number', 'macos/1.0.0 contract/x'],
    ['a negative contract', 'macos/1.0.0 contract/-1'],
    ['a contract past six digits', 'macos/1.0.0 contract/1234567'],
    ['an upper-case platform', 'MacOS/1.0.0 contract/1'],
    ['two spaces', 'macos/1.0.0  contract/1'],
    ['something before it', 'x macos/1.0.0 contract/1'],
    ['a trailing space', 'macos/1.0.0 contract/1 '],
    ['a newline', 'macos/1.0.0 contract/1\nx'],
    ['a version that is not semantic', 'macos/one contract/1'],
    ['a version of two parts', 'macos/1.0 contract/1'],
    ['build metadata, which is no part of the shape', 'macos/1.0.0+212 contract/1'],
    ['a version past thirty-two characters', `macos/1.0.0-${'a'.repeat(40)} contract/1`],
    ['a pre-release with nothing after the hyphen', 'macos/1.0.0- contract/1'],
    ['a pre-release that is only dots', 'macos/1.0.0-.. contract/1'],
    [
      'the header twice, as a proxy folds it into one line',
      'macos/1.0.0 contract/1, macos/1.0.0 contract/1',
    ],
    ['a contract with a leading plus', 'macos/1.0.0 contract/+1'],
  ])('%s is no client', (_name, value) => {
    expect(parseClientHeader(value)).toBeNull();
  });
});

describe('comparing versions', () => {
  test.each([
    ['1.0.0', '1.0.0', 0],
    ['1.0.1', '1.0.0', 1],
    ['1.0.0', '1.0.1', -1],
    ['1.10.0', '1.9.0', 1],
    ['2.0.0', '1.99.99', 1],
    // A pre-release is before the release it leads to.
    ['1.0.0-rc.1', '1.0.0', -1],
    ['1.0.0', '1.0.0-rc.1', 1],
    ['1.0.0-rc.2', '1.0.0-rc.10', -1],
    ['1.0.0-alpha', '1.0.0-beta', -1],
    ['1.0.0-1', '1.0.0-alpha', -1],
    ['1.0.0-alpha', '1.0.0-1', 1],
    // A hyphen inside a pre-release belongs to it: only the first one separates it from the core.
    ['1.0.0-rc-1', '1.0.0-rc-2', -1],
    ['1.0.0-rc-2', '1.0.0-rc-1', 1],
    ['1.0.0-rc-1', '1.0.0-rc-1', 0],
    // The shorter list of identifiers is the earlier, when all it has are shared.
    ['1.0.0-rc', '1.0.0-rc.1', -1],
    ['1.0.0-rc.1', '1.0.0-rc', 1],
    ['1.2.0', '1.1.9', 1],
    ['1.1.9', '1.2.0', -1],
  ] as const)('%s against %s is %d', (a, b, expected) => {
    expect(Math.sign(compareVersions(a, b))).toBe(expected);
  });
});

describe('who is refused', () => {
  const macos = (version: string, contract: number): string =>
    `macos/${version} contract/${String(contract)}`;

  test('nobody, where no minimum is set', () => {
    expect(clientRefusal(macos('0.0.1', 1), policy())).toBeNull();
  });

  test('a client below the minimum contract', () => {
    const refusal = clientRefusal(macos('9.9.9', 1), policy({ contract: 2 }));
    expect(refusal).toEqual({ minContract: 2, minVersion: null, downloadUrl: null });
  });

  test('a client at the minimum contract is let through, and so is one above it', () => {
    expect(clientRefusal(macos('1.0.0', 2), policy({ contract: 2 }))).toBeNull();
    expect(clientRefusal(macos('1.0.0', 3), policy({ contract: 2 }))).toBeNull();
  });

  test('a client below the minimum version, whatever its contract', () => {
    const refusal = clientRefusal(
      macos('1.2.3', 9),
      policy({ version: '1.3.0', downloadUrl: 'https://example.test/get' }),
    );
    expect(refusal).toEqual({
      minContract: null,
      minVersion: '1.3.0',
      downloadUrl: 'https://example.test/get',
    });
  });

  test('a client at the minimum version is let through', () => {
    expect(clientRefusal(macos('1.3.0', 1), policy({ version: '1.3.0' }))).toBeNull();
  });

  test('a pre-release of the minimum version is below it', () => {
    expect(clientRefusal(macos('1.3.0-rc.1', 1), policy({ version: '1.3.0' }))).not.toBeNull();
  });

  test('either rule is enough', () => {
    const both = policy({ contract: 2, version: '1.3.0' });
    expect(clientRefusal(macos('1.4.0', 1), both)).not.toBeNull();
    expect(clientRefusal(macos('1.2.0', 5), both)).not.toBeNull();
    expect(clientRefusal(macos('1.4.0', 5), both)).toBeNull();
  });

  test('a platform nobody set a minimum for is never refused', () => {
    expect(clientRefusal('linux/0.0.1 contract/1', policy({ contract: 99 }))).toBeNull();
  });

  test('an unreadable header is never refused: a browser sends none and a typo must not lock anyone out', () => {
    expect(clientRefusal(null, policy({ contract: 99 }))).toBeNull();
    expect(clientRefusal('macos/1.0.0 contract/x', policy({ contract: 99 }))).toBeNull();
  });
});

describe('what a client too old may still ask', () => {
  test.each([
    '/api/client',
    '/api/client/',
    '//api//client',
    '/api/client//',
    '/health',
    '/health/',
    '/health/ready',
    '/health/ready/',
  ])('%s is answered whatever the version', (path) => {
    expect(isOutsideClientPolicy(path)).toBe(true);
  });

  // The router is not strict about a slash, but it is about everything else: a path that merely begins
  // with an exempt one is not it, and neither is another spelling of it.
  test.each([
    '/api/me',
    '/api/clients',
    '/api/client/x',
    '/api/clientx',
    '/healthz',
    '/health/ready/x',
    '/health/live',
    '/ws',
    '/auth/logout',
    '/',
  ])('%s is not', (path) => {
    expect(isOutsideClientPolicy(path)).toBe(false);
  });
});
