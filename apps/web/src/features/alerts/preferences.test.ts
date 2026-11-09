import { describe, expect, test } from 'bun:test';
import { DEFAULT_ALERT_PREFERENCES, parseAlertPreferences } from './preferences';

describe('device alert preferences', () => {
  test('new devices retain sound and get in-app alerts without granting desktop permission', () => {
    expect(parseAlertPreferences(null)).toEqual({ inApp: true, sound: true, volume: 50 });
  });
  test('independent opt-outs and volume boundaries survive a reload', () => {
    for (const volume of [0, 1, 100]) {
      const chosen = { inApp: false, sound: false, volume };
      expect(parseAlertPreferences(JSON.stringify(chosen))).toEqual(chosen);
    }
  });
  test('malformed, oversized and wrong-typed storage does not grant new capabilities', () => {
    for (const text of [
      '',
      'null',
      '[]',
      '{',
      '{}',
      'x'.repeat(1025),
      ' '.repeat(1025) + '{"inApp":false,"sound":false,"volume":0}',
      '{"inApp":true,"sound":"false","volume":50}',
      '{"inApp":true,"sound":true,"volume":101}',
      '{"inApp":true,"sound":true,"volume":-1}',
      '{"inApp":true,"sound":true,"volume":0.5}',
    ]) {
      expect(parseAlertPreferences(text)).toEqual(DEFAULT_ALERT_PREFERENCES);
    }
  });
});
