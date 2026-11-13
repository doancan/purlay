/**
 * The audit vocabulary is one list on the wire and three owners in the code: the core's and each module's manifest names its
 * own (`MODULES.md` §2). They are the same actions, each owned once: an action added to one list and not to an owner, or to
 * two, fails here instead of reaching a trail nobody can filter.
 */
import { describe, expect, test } from 'bun:test';
import { AUDIT_ACTIONS, CHAT_AUDIT_ACTIONS, CORE_AUDIT_ACTIONS, ISSUES_AUDIT_ACTIONS } from './api';

describe('who owns each audit action', () => {
  test('workspace MFA security changes belong to the core', () => {
    for (const action of [
      'workspace.mfa.enrolled',
      'workspace.mfa.rotated',
      'workspace.mfa.revoked',
      'workspace.mfa.recovery_codes_rotated',
      'workspace.mfa.recovery_used',
      'workspace.security.policy_tested',
      'workspace.security.policy_updated',
      'workspace.security.recovery_created',
      'workspace.security.policy_recovered',
    ])
      expect(CORE_AUDIT_ACTIONS as readonly string[]).toContain(action);
  });

  const owned: readonly string[] = [
    ...CORE_AUDIT_ACTIONS,
    ...CHAT_AUDIT_ACTIONS,
    ...ISSUES_AUDIT_ACTIONS,
  ];

  test('every action of the wire has an owner, and none is owned twice', () => {
    expect([...owned].sort()).toEqual([...AUDIT_ACTIONS].sort());
    expect(new Set(owned).size).toBe(owned.length);
  });
});
