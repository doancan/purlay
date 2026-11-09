/** Personal device choices; desktop permission remains a separate explicit browser opt-in. */
import { Type, type Static } from '@sinclair/typebox';

export const AlertPreferences = Type.Object(
  {
    inApp: Type.Boolean(),
    sound: Type.Boolean(),
    volume: Type.Integer({ minimum: 0, maximum: 100 }),
  },
  { additionalProperties: false },
);
export type AlertPreferences = Static<typeof AlertPreferences>;
