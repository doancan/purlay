import { describe, expect, test } from 'bun:test';
import { isAppOrigin } from './origin';

describe('the application origin', () => {
  const app = 'https://chat.example.com';

  test('the exact origin is the application', () => {
    expect(isAppOrigin(app, app)).toBe(true);
  });

  test('anything else is not: another host, a sibling subdomain, another scheme or port', () => {
    for (const origin of [
      'https://evil.example',
      'https://evil.chat.example.com',
      'https://chat.example.com.evil.example',
      'http://chat.example.com',
      'https://chat.example.com:8443',
      'https://chat.example.com/',
      'null',
      '',
      null,
    ]) {
      expect({ origin, accepted: isAppOrigin(origin, app) }).toEqual({ origin, accepted: false });
    }
  });
});
