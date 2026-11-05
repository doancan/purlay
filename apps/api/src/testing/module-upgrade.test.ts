import { describe, expect, test } from 'bun:test';
import { latestReleaseTag, main, releaseSettingFor } from './module-upgrade';

describe('which tag is the last release', () => {
  test('is the highest version, not the last name', () => {
    expect(latestReleaseTag(['v0.9.0', 'v0.10.0', 'v0.2.1', 'v0.10.0-rc.1'])).toBe('v0.10.0');
    expect(latestReleaseTag(['v1.0.0', 'v0.99.99'])).toBe('v1.0.0');
  });

  test('is nothing when no tag is a release', () => {
    expect(latestReleaseTag([])).toBeUndefined();
    expect(latestReleaseTag(['nightly', 'v1', 'v1.2.3-beta'])).toBeUndefined();
  });
});

describe('the database an operator had under the release', () => {
  test('keeps the modules the release carried, and the core alone when none of them', () => {
    expect(releaseSettingFor(['chat', 'issues'], ['chat', 'issues'])).toBe('chat,issues');
    expect(releaseSettingFor(['issues'], ['chat', 'issues'])).toBe('issues');
    expect(releaseSettingFor(['notes'], ['chat', 'issues'])).toBe('none');
    expect(releaseSettingFor(['chat', 'notes'], ['chat'])).toBe('chat');
    expect(releaseSettingFor([], ['chat'])).toBe('none');
  });

  test('is unset for a release that carried no module, since it knows no MODULES', () => {
    expect(releaseSettingFor(['chat'], [])).toBeUndefined();
    expect(releaseSettingFor([], [])).toBeUndefined();
  });
});

describe('the command', () => {
  const said = (): { out: string[]; err: string[]; say: Parameters<typeof main>[1] } => {
    const out: string[] = [];
    const err: string[] = [];
    return {
      out,
      err,
      say: {
        out: (line) => void out.push(line),
        err: (line) => void err.push(line),
      },
    };
  };

  test('fails, saying so, without a database to use', async () => {
    const { err, say } = said();
    expect(await main({}, say, () => ['v0.1.0'])).toBe(1);
    expect(err.join('\n')).toContain('DATABASE_URL is not set');
  });

  test('fails rather than passing with nothing to start from when the checkout has no release tag', async () => {
    const { err, say } = said();
    expect(await main({ DATABASE_URL: 'postgres://x@localhost/x' }, say, () => [])).toBe(1);
    expect(err.join('\n')).toContain('no release tag');
    expect(err.join('\n')).toContain('git fetch --tags');
  });
});
