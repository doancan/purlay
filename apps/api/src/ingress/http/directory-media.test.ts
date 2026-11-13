/** SCIM's JSON media is accepted only at its native resource boundary; normal CSRF/body caps remain. */
import { describe, expect, test } from 'bun:test';
import { hasUnsupportedMediaType, isCrossSiteMutation } from './edge';
const request = (path: string, type = 'application/scim+json'): Request =>
  new Request('https://purlay.test' + path, {
    method: 'PATCH',
    headers: { 'content-type': type },
    body: '{}',
  });
describe('native directory media boundary', () => {
  test('SCIM resource mutations accept protocol JSON and reject form-compatible types', () => {
    for (const path of [
      '/auth/scim/v2/Users',
      '/auth/scim/v2/Users/resource',
      '/auth/scim/v2/Groups',
      '/auth/scim/v2/Groups/resource',
    ]) {
      expect(hasUnsupportedMediaType(request(path))).toBe(false);
      expect(hasUnsupportedMediaType(request(path, 'application/scim+json; charset=utf-8'))).toBe(
        false,
      );
      expect(hasUnsupportedMediaType(request(path, 'text/plain'))).toBe(true);
    }
  });
  test('unrelated auth/admin/unknown paths do not inherit the SCIM media exception or a cross-site exemption', () => {
    for (const path of [
      '/auth/scim/v2',
      '/auth/scim/v2/Users/resource/extra',
      '/auth/scim/v2/Users/',
      '/auth/scim/connections',
      '/auth/sign-in/email',
      '/api/workspaces',
    ])
      expect(hasUnsupportedMediaType(request(path))).toBe(true);
    const cross = new Request(request('/auth/scim/v2/Users/resource'), {
      headers: { origin: 'https://foreign.test', 'content-type': 'application/scim+json' },
    });
    expect(isCrossSiteMutation(cross, 'https://purlay.test')).toBe(true);
  });
});
