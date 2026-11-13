import { describe, expect, test } from 'bun:test';
import { Value } from '@sinclair/typebox/value';
import {
  CreateWorkspacePolicyRecoveryRequest,
  PreviewWorkspacePolicyRequest,
  TestWorkspacePolicyRequest,
  StartWorkspaceMfaEnrollmentRequest,
  StartWorkspaceMfaChallengeRequest,
  UpdateWorkspacePolicyRequest,
  VerifyWorkspaceMfaRequest,
  WorkspaceAccessPolicy,
  WorkspaceMfaFactor,
  WorkspacePolicySettings,
  WORKSPACE_MFA_CODE_DIGITS,
  WORKSPACE_MFA_PERIOD_SECONDS,
  WORKSPACE_MFA_SECRET_BYTES,
} from './workspace-security';

const policy = (): WorkspacePolicySettings => ({
  mode: 'off',
  signIn: 'any',
  allowedConnectionIds: [],
  requireMfa: false,
  idleMinutes: null,
  maxAgeHours: null,
  mfaMaxAgeMinutes: null,
});

describe('workspace security contracts', () => {
  test('recovery regeneration carries a purpose-bound paired proof without accepting a lone test field', () => {
    const testId = crypto.randomUUID();
    const testToken = 'a'.repeat(43);
    expect(Value.Check(CreateWorkspacePolicyRecoveryRequest, { policyRevision: null })).toBe(true);
    expect(
      Value.Check(CreateWorkspacePolicyRecoveryRequest, {
        policyRevision: null,
        testId,
        testToken,
      }),
    ).toBe(true);
    for (const field of [{ testId }, { testToken }])
      expect(
        Value.Check(CreateWorkspacePolicyRecoveryRequest, { policyRevision: null, ...field }),
      ).toBe(false);
    for (const purpose of ['policy', 'recovery_setup'])
      expect(
        Value.Check(TestWorkspacePolicyRequest, { revision: null, policy: policy(), purpose }),
      ).toBe(true);
    expect(
      Value.Check(TestWorkspacePolicyRequest, {
        revision: null,
        policy: policy(),
        purpose: 'disable_policy',
      }),
    ).toBe(false);
  });

  test('resumes a policy test only with its complete observed proof pair', () => {
    const initial = { revision: null, policy: policy() };
    const testId = crypto.randomUUID();
    const testToken = 'a'.repeat(43);
    expect(Value.Check(TestWorkspacePolicyRequest, initial)).toBe(true);
    expect(Value.Check(TestWorkspacePolicyRequest, { ...initial, testId, testToken })).toBe(true);
    expect(Value.Check(TestWorkspacePolicyRequest, { ...initial, testId })).toBe(false);
    expect(Value.Check(TestWorkspacePolicyRequest, { ...initial, testToken })).toBe(false);
    expect(
      Value.Check(TestWorkspacePolicyRequest, { ...initial, testId, testToken: 'short' }),
    ).toBe(false);
    expect(
      Value.Check(TestWorkspacePolicyRequest, {
        ...initial,
        testId,
        testToken,
        testedAt: 'chosen',
      }),
    ).toBe(false);
  });

  test('workspace challenges cannot request global credential verification', () => {
    const request = { policyRevision: null, purpose: 'step_up', factorScope: 'workspace' };
    expect(Value.Check(StartWorkspaceMfaChallengeRequest, request)).toBe(true);
    expect(
      Value.Check(StartWorkspaceMfaChallengeRequest, { ...request, factorScope: 'global' }),
    ).toBe(false);
  });

  test('keeps shared authenticator parameters exact and rejects non-ASCII or trailing code data', () => {
    expect(WORKSPACE_MFA_CODE_DIGITS).toBe(6);
    expect(WORKSPACE_MFA_PERIOD_SECONDS).toBe(30);
    expect(WORKSPACE_MFA_SECRET_BYTES).toBe(32);
    const challengeId = 'a'.repeat(43);
    expect(Value.Check(VerifyWorkspaceMfaRequest, { challengeId, code: '001234' })).toBe(true);
    for (const code of [
      '',
      '12345',
      '12345' + String.fromCharCode(10),
      '12345' + String.fromCharCode(13),
      '1234567',
      '123456\n',
      '１２３４５６',
      '١٢٣٤٥٦',
      '123 45',
      123456,
    ])
      expect(Value.Check(VerifyWorkspaceMfaRequest, { challengeId, code })).toBe(false);
  });

  test('bounds policy lists and times without accepting a caller-provided authority', () => {
    expect(Value.Check(WorkspacePolicySettings, policy())).toBe(true);
    for (const [field, minimum, maximum] of [
      ['idleMinutes', 5, 1440],
      ['maxAgeHours', 1, 720],
      ['mfaMaxAgeMinutes', 5, 1440],
    ] as const) {
      for (const value of [minimum, maximum, null])
        expect(Value.Check(WorkspacePolicySettings, { ...policy(), [field]: value })).toBe(true);
      for (const value of [minimum - 1, maximum + 1, 1.5, '5'])
        expect(Value.Check(WorkspacePolicySettings, { ...policy(), [field]: value })).toBe(false);
    }
    const ids = Array.from({ length: 16 }, () => crypto.randomUUID());
    expect(Value.Check(WorkspacePolicySettings, { ...policy(), allowedConnectionIds: ids })).toBe(
      true,
    );
    for (const allowedConnectionIds of [[...ids, crypto.randomUUID()], [ids[0], ids[0]], ['bad']])
      expect(Value.Check(WorkspacePolicySettings, { ...policy(), allowedConnectionIds })).toBe(
        false,
      );
    for (const extra of [
      { userId: crypto.randomUUID() },
      { epoch: '1' },
      { testedAt: 'now' },
      { mfaVerified: true },
    ])
      expect(
        Value.Check(PreviewWorkspacePolicyRequest, { revision: null, policy: policy(), ...extra }),
      ).toBe(false);
  });

  test('edits and enrollment carry observed revisions, not user or factor ownership mappings', () => {
    const revision = crypto.randomUUID();
    const valid = {
      revision,
      policy: policy(),
      testId: crypto.randomUUID(),
      testToken: 'a'.repeat(43),
    };
    expect(Value.Check(UpdateWorkspacePolicyRequest, valid)).toBe(true);
    for (const field of ['revision', 'policy', 'testId', 'testToken']) {
      const missing = { ...valid };
      Reflect.deleteProperty(missing, field);
      expect(Value.Check(UpdateWorkspacePolicyRequest, missing)).toBe(false);
    }
    expect(
      Value.Check(StartWorkspaceMfaEnrollmentRequest, {
        policyRevision: null,
        factorRevision: null,
      }),
    ).toBe(true);
    for (const extra of [
      { userId: crypto.randomUUID() },
      { workspaceId: crypto.randomUUID() },
      { secret: 'chosen' },
      { verified: true },
    ])
      expect(
        Value.Check(StartWorkspaceMfaEnrollmentRequest, {
          policyRevision: revision,
          factorRevision: null,
          ...extra,
        }),
      ).toBe(false);
  });

  test('public policy epochs are lossless decimal strings and factor inventories have no secret fields', () => {
    const response: WorkspaceAccessPolicy = {
      ...policy(),
      revision: null,
      epoch: '0',
      testedAt: null,
      updatedAt: null,
    };
    expect(Value.Check(WorkspaceAccessPolicy, response)).toBe(true);
    expect(Value.Check(WorkspaceAccessPolicy, { ...response, epoch: '9007199254740993' })).toBe(
      true,
    );
    for (const epoch of [0, '-1', '01', '1.0', '1\n'])
      expect(Value.Check(WorkspaceAccessPolicy, { ...response, epoch })).toBe(false);
    for (const field of [
      'secret',
      'secretEncrypted',
      'uri',
      'recoveryCodes',
      'lastAcceptedCounter',
    ])
      expect(Object.keys(WorkspaceMfaFactor.properties)).not.toContain(field);
  });
});
