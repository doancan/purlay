/** Real canonical server configuration and the small module catalogue used by push integration worlds. */
import type { Executor } from '@purlay/db';
import type { Clock } from '../platform/clock';
import { credentialCipher } from '../platform/crypto';
import { DEVELOPMENT_ENCRYPTION_KEY } from '../platform/config';
import { effectiveModules, type EntitlementPolicy } from '../platform/module-kit/entitlement';
import { pushConfiguration } from '../modules/push/settings';
import { testConfig } from './doubles';
import { KEYS } from './push-service';

export const enableTestPush = async (database: Executor, clock: Clock): Promise<void> => {
  await pushConfiguration(database, credentialCipher(DEVELOPMENT_ENCRYPTION_KEY), clock, {
    ...testConfig(),
    VAPID_PUBLIC_KEY: KEYS.publicKey,
    VAPID_PRIVATE_KEY: KEYS.privateKey,
    VAPID_SUBJECT: KEYS.subject,
  }).view();
};

const effective: EntitlementPolicy['effective'] = (rows, now) =>
  effectiveModules({
    rows,
    now,
    mode: 'open',
    running: [
      { id: 'chat', requires: [], entitlement: 'always' },
      { id: 'things', requires: [], entitlement: 'grant' },
    ],
  });

export const TEST_PUSH_POLICY = {
  owner: 'chat',
  inboxKinds: new Map([['thing_assigned', 'things']]),
  effectiveModules: effective,
} as const;
