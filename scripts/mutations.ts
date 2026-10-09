/**
 * The mutations `bun run mutate` applies (`scripts/mutate.ts`, `CONTRIBUTING.md` §5).
 *
 * Each is something a reviewer could plausibly let through, written against the code
 * as it is: when the code moves, the entry goes stale and the run says so.
 */
import type { Mutation } from './mutate';

export const MUTATIONS: readonly Mutation[] = [
  {
    id: 'oauth-state-signature-unchecked',
    why: 'a cookie an attacker wrote is accepted, so the callback signs a victim into the attacker’s account',
    file: 'apps/api/src/modules/auth/state.ts',
    find: 'if (!equal(signature, await sign(encryptionKey, payload))) return false;',
    replace: '',
    tests: ['apps/api/src/modules/auth/state.test.ts'],
  },
];
