/**
 * The built client, served from the one origin (D-61): which paths are whose, which
 * file a path means, and what the API refuses to start with.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigurationError } from '../../platform/config';
import {
  IMMUTABLE,
  clientFileFor,
  fileFor,
  isUnchanged,
  openClient,
  routeOf,
  type Route,
} from './client';

const dist = mkdtempSync(join(tmpdir(), 'client-dist-'));
mkdirSync(join(dist, 'assets'));
writeFileSync(join(dist, 'index.html'), '<!doctype html><title>shell</title>');
writeFileSync(join(dist, 'assets', 'app-abc123.js'), 'console.log(1)');
writeFileSync(join(dist, 'theme-init.js'), '/* theme */');
const empty = mkdtempSync(join(tmpdir(), 'client-empty-'));

afterAll(() => {
  rmSync(dist, { recursive: true, force: true });
  rmSync(empty, { recursive: true, force: true });
});

describe('which paths are whose', () => {
  test.each<[string, Route]>([
    ['/ws', 'socket'],
    ['/ws/x', 'api'],
    ['/api/me', 'api'],
    ['/api', 'api'],
    ['/api/', 'api'],
    ['/auth/github', 'api'],
    ['/health', 'api'],
    ['/health/ready', 'api'],
    ['/', 'client'],
    ['/w/acme/c/1', 'client'],
    ['/apiary', 'client'],
    ['/authors', 'client'],
    ['/wsx', 'client'],
    ['/assets/app.js', 'client'],
  ])('%s is %s', (path, route) => {
    expect(routeOf(path)).toBe(route);
  });
});

describe('a path cannot climb out of the build', () => {
  test.each([
    '/../etc/passwd',
    '/%2e%2e/%2e%2e/etc/passwd',
    '/assets/..%2f..%2fetc%2fpasswd',
    '/%E0%A4%A',
    '/assets/x.js%00.html',
  ])('%s means no file', (path) => {
    expect(fileFor(dist, path)).toBeNull();
  });

  test('a path inside the build is that file', () => {
    expect(fileFor(dist, '/assets/x.js')).toBe(join(dist, 'assets', 'x.js'));
    expect(fileFor(dist, '/')?.startsWith(dist)).toBe(true);
  });

  test('a sibling directory sharing the prefix is outside, not inside', () => {
    expect(fileFor(dist, `/../${dist.split('/').at(-1) ?? ''}-evil/x`)).toBeNull();
  });
});

describe('which file a path is answered with', () => {
  const client = openClient(dist);

  test('a hashed asset is kept for good', () => {
    expect(clientFileFor(client, '/assets/app-abc123.js')).toMatchObject({
      path: join(dist, 'assets', 'app-abc123.js'),
      document: false,
      cacheControl: IMMUTABLE,
    });
  });

  test('a file without a hash is asked about every time', () => {
    expect(clientFileFor(client, '/theme-init.js')?.cacheControl).toBe('no-cache');
  });

  test.each(['/', '/w/acme/c/1', '/index.html'])(
    '%s is the shell, a document asked about every time',
    (path) => {
      expect(clientFileFor(client, path)).toMatchObject({
        path: join(dist, 'index.html'),
        document: true,
        cacheControl: 'no-cache',
      });
    },
  );

  test('names its version by size and modification, the same for the same file', () => {
    const shell = clientFileFor(client, '/')?.etag;
    expect(shell).toMatch(/^W\/"[0-9a-z]+-[0-9a-z]+"$/);
    expect(clientFileFor(client, '/w/acme')?.etag).toBe(shell);
    expect(clientFileFor(client, '/theme-init.js')?.etag).not.toBe(shell);
  });

  test.each([
    '/assets/gone.js',
    '/favicon.ico',
    '/../etc/passwd',
    '/assets',
    // The API's paths, spelled so the raw path does not start with them: still the API's.
    '/%61pi/me',
    '/api%2Fme',
    '/ws%2f',
    '/%68ealth',
  ])('%s is not a file and not a client route: nothing', (path) => {
    expect(clientFileFor(client, path)).toBeUndefined();
  });
});

describe('opening the build', () => {
  test('a directory with a shell opens', () => {
    expect(openClient(dist).dist).toBe(dist);
  });

  test('a directory without index.html refuses to start, naming the variable', () => {
    expect(() => openClient(empty)).toThrow(ConfigurationError);
    expect(() => openClient(empty)).toThrow(/CLIENT_DIST/);
  });

  test('a trailing separator names the same build, not one every path falls outside', () => {
    const client = openClient(`${dist}/`);
    expect(clientFileFor(client, '/')?.path).toBe(join(dist, 'index.html'));
    expect(clientFileFor(client, '/assets/app-abc123.js')?.path).toBe(
      join(dist, 'assets', 'app-abc123.js'),
    );
  });

  test('a relative path refuses to start: what is served must not depend on where it was started', () => {
    expect(() => openClient('apps/web/dist')).toThrow(/CLIENT_DIST: must be an absolute path/);
  });

  test('a directory that is not there refuses to start', () => {
    expect(() => openClient(join(empty, 'missing'))).toThrow(/CLIENT_DIST/);
  });
});

describe('whether the browser already has it', () => {
  const etag = 'W/"a-b"';
  test.each<[string | null, boolean]>([
    ['W/"a-b"', true],
    ['"a-b"', true],
    ['W/"x-y", W/"a-b"', true],
    ['*', true],
    ['W/"x-y"', false],
    ['', false],
    [null, false],
  ])('If-None-Match %p is %p', (header, unchanged) => {
    expect(isUnchanged(header, etag)).toBe(unchanged);
  });
});

describe('a build that cannot be read', () => {
  test('is named for what it is, not as missing', () => {
    const locked = mkdtempSync(join(tmpdir(), 'client-locked-'));
    writeFileSync(join(locked, 'index.html'), 'x');
    chmodSync(locked, 0o000);
    try {
      expect(() => openClient(locked)).toThrow(/cannot be read \(EACCES\)/);
    } finally {
      chmodSync(locked, 0o700);
      rmSync(locked, { recursive: true, force: true });
    }
  });
});
