import { AlertPreferences } from '@purlay/types';
import { Value } from '@sinclair/typebox/value';

export const DEFAULT_ALERT_PREFERENCES: AlertPreferences = { inApp: true, sound: true, volume: 50 };

export const parseAlertPreferences = (text: string | null): AlertPreferences => {
  if (text === null || text.length > 1024) return DEFAULT_ALERT_PREFERENCES;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return DEFAULT_ALERT_PREFERENCES;
  }
  return Value.Check(AlertPreferences, value) ? value : DEFAULT_ALERT_PREFERENCES;
};
