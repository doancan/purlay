/** Real runtime decoding, exact bodies and abort/error behavior of the lazy security client. */
import { expect, test } from 'bun:test';
import { createApi } from './api';
import { createHttp, type FetchPort } from './http';
import { ApiError } from './errors';
import { IDS } from '../testing/fixtures';
import {
  SECURITY_CHALLENGE,
  SECURITY_CODES,
  SECURITY_ENROLLMENT,
  SECURITY_ENTRY,
  SECURITY_MFA,
  SECURITY_POLICY,
  SECURITY_PREVIEW,
  SECURITY_STATUS,
  SECURITY_TEST,
} from '../testing/workspace-security';

const setup = (): {
  readonly api: ReturnType<typeof createApi>;
  readonly seen: { url: string; init: RequestInit }[];
  readonly reply: (value: unknown) => void;
  readonly refuse: (value: unknown) => void;
} => {
  const seen: { url: string; init: RequestInit }[] = [];
  let response: Response = Response.json(SECURITY_STATUS);
  const fetch: FetchPort = (url, init) => {
    seen.push({ url, init });
    return Promise.resolve(response.clone());
  };
  return {
    api: createApi(createHttp(fetch)),
    seen,
    reply: (value: unknown): void => {
      response = Response.json(value);
    },
    refuse: (value: unknown): void => {
      response = Response.json({ error: value }, { status: 403 });
    },
  };
};
const body = (request: { init: RequestInit } | undefined): unknown => {
  if (typeof request?.init.body !== 'string') throw new Error('Expected JSON body');
  return JSON.parse(request.init.body) as unknown;
};

test('security reads decode real contracts and preserve path/query encoding, credentials and AbortSignal', async () => {
  const w = setup();
  const controller = new AbortController();
  w.reply(SECURITY_ENTRY);
  expect(await w.api.workspaceSecurityEntry('acme / test', controller.signal)).toEqual(
    SECURITY_ENTRY,
  );
  expect(w.seen[0]?.url).toBe('/api/workspace-security?workspace=acme+%2F+test');
  w.reply(SECURITY_STATUS);
  await w.api.workspaceAccess('workspace/with space', controller.signal);
  expect(w.seen[1]?.url).toBe('/api/workspaces/workspace%2Fwith%20space/security/access');
  w.reply(SECURITY_POLICY);
  expect(await w.api.workspacePolicy(IDS.workspace, controller.signal)).toEqual(SECURITY_POLICY);
  w.reply(SECURITY_MFA);
  expect(await w.api.myWorkspaceMfa(IDS.workspace, controller.signal)).toEqual(SECURITY_MFA);
  for (const request of w.seen) {
    expect(request.init.method).toBe('GET');
    expect(request.init.credentials).toBe('same-origin');
    expect(request.init.signal).toBe(controller.signal);
  }
  controller.abort();
  expect(w.seen.every((request) => request.init.signal?.aborted)).toBe(true);
});

test('preview, initial/resumed test and enforcement keep the exact observed policy and ticket', async () => {
  const w = setup();
  const {
    revision,
    mode,
    signIn,
    allowedConnectionIds,
    requireMfa,
    idleMinutes,
    maxAgeHours,
    mfaMaxAgeMinutes,
  } = SECURITY_POLICY;
  const policy = {
    mode,
    signIn,
    allowedConnectionIds,
    requireMfa,
    idleMinutes,
    maxAgeHours,
    mfaMaxAgeMinutes,
  };
  const initial = { revision, policy };
  w.reply(SECURITY_PREVIEW);
  await w.api.previewWorkspacePolicy(IDS.workspace, { ...initial, before: 'next page', limit: 1 });
  expect(w.seen[0]?.url).toBe(`/api/workspaces/${IDS.workspace}/security/policy/preview`);
  expect(body(w.seen[0])).toEqual({ ...initial, before: 'next page', limit: 1 });
  w.reply(SECURITY_TEST);
  await w.api.testWorkspacePolicy(IDS.workspace, initial);
  expect(body(w.seen[1])).toEqual(initial);
  const resumed = { ...initial, testId: SECURITY_TEST.testId, testToken: SECURITY_TEST.testToken };
  await w.api.testWorkspacePolicy(IDS.workspace, resumed);
  expect(body(w.seen[2])).toEqual(resumed);
  await w.api.testWorkspacePolicy(IDS.workspace, { ...initial, purpose: 'recovery_setup' });
  expect(body(w.seen[3])).toEqual({ ...initial, purpose: 'recovery_setup' });
  w.reply(SECURITY_POLICY);
  await w.api.updateWorkspacePolicy(IDS.workspace, resumed);
  expect(w.seen[4]?.init.method).toBe('PUT');
  expect(body(w.seen[4])).toEqual(resumed);
  for (const request of w.seen) expect(request.url).not.toContain(SECURITY_TEST.testToken);
});

test('MFA enrollment, purpose-bound challenges, verification and recovery send secrets only in JSON', async () => {
  const w = setup();
  const enrollment = {
    policyRevision: IDS.alice,
    factorRevision: IDS.bob,
    authorizationChallengeId: SECURITY_CHALLENGE.challengeId,
  };
  w.reply(SECURITY_ENROLLMENT);
  await w.api.startWorkspaceMfaEnrollment(IDS.workspace, enrollment);
  expect(body(w.seen[0])).toEqual(enrollment);
  const challenge = {
    policyRevision: IDS.alice,
    purpose: 'policy_test' as const,
    factorScope: 'workspace' as const,
    testId: SECURITY_TEST.testId,
  };
  w.reply(SECURITY_CHALLENGE);
  await w.api.startWorkspaceMfaChallenge(IDS.workspace, challenge);
  expect(body(w.seen[1])).toEqual(challenge);
  w.reply({
    status: SECURITY_STATUS,
    factor: SECURITY_ENROLLMENT.factor,
    recoveryCodes: SECURITY_CODES,
  });
  await w.api.verifyWorkspaceMfa(IDS.workspace, {
    challengeId: SECURITY_CHALLENGE.challengeId,
    code: '123456',
  });
  expect(body(w.seen[2])).toEqual({ challengeId: SECURITY_CHALLENGE.challengeId, code: '123456' });
  await w.api.recoverWorkspaceMfa(IDS.workspace, {
    challengeId: SECURITY_CHALLENGE.challengeId,
    code: SECURITY_CODES.backupCodes[0] ?? '',
  });
  expect(w.seen[3]?.url).toBe(`/api/workspaces/${IDS.workspace}/security/mfa/recovery`);
  w.reply(SECURITY_MFA);
  await w.api.disableWorkspaceMfa(IDS.workspace, enrollment);
  expect(w.seen[4]?.init.method).toBe('DELETE');
  expect(body(w.seen[4])).toEqual(enrollment);
  w.reply(SECURITY_CODES);
  expect(await w.api.newWorkspaceMfaRecoveryCodes(IDS.workspace, enrollment)).toEqual(
    SECURITY_CODES,
  );
  for (const request of w.seen) {
    expect(request.url).not.toContain(SECURITY_CHALLENGE.challengeId);
    expect(request.url).not.toContain('123456');
  }
});

test('owner recovery supports direct and purpose-bound creation and the typed opaque pair', async () => {
  const w = setup();
  const recovery = { revision: IDS.bob, recoveryCode: 'r'.repeat(43) };
  w.reply(recovery);
  expect(
    await w.api.createWorkspacePolicyRecovery(IDS.workspace, { policyRevision: IDS.alice }),
  ).toEqual(recovery);
  const recoverySetup = {
    policyRevision: IDS.alice,
    testId: SECURITY_TEST.testId,
    testToken: SECURITY_TEST.testToken,
  };
  await w.api.createWorkspacePolicyRecovery(IDS.workspace, recoverySetup);
  expect(body(w.seen[1])).toEqual(recoverySetup);
  w.reply(SECURITY_POLICY);
  await w.api.recoverWorkspacePolicy(IDS.workspace, recovery);
  expect(body(w.seen[2])).toEqual(recovery);
  expect(w.seen[2]?.url).not.toContain(recovery.recoveryCode);
});

test('malformed security data cannot become authority and refusal hints stay validated and optional', async () => {
  const w = setup();
  w.reply({ workspaceId: IDS.workspace, state: 'allowed' });
  expect(await w.api.workspaceAccess(IDS.workspace).catch((error: unknown) => error)).toMatchObject(
    { code: 'MALFORMED' },
  );
  w.refuse({
    code: 'WORKSPACE_ACCESS_REQUIRED',
    message: 'Verify.',
    details: { workspaceId: IDS.workspace },
  });
  expect(await w.api.workspaceAccess(IDS.workspace).catch((error: unknown) => error)).toMatchObject(
    { code: 'WORKSPACE_ACCESS_REQUIRED', workspaceId: IDS.workspace },
  );
  w.refuse({ code: 'WORKSPACE_ACCESS_REQUIRED', message: 'Verify.' });
  expect(await w.api.workspaceAccess(IDS.workspace).catch((error: unknown) => error)).toMatchObject(
    { workspaceId: null },
  );
  w.refuse({
    code: 'WORKSPACE_ACCESS_REQUIRED',
    message: 'Verify.',
    details: { workspaceId: 'foreign/slug' },
  });
  const failure: unknown = await w.api
    .workspaceAccess(IDS.workspace)
    .catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(ApiError);
  expect(failure).toMatchObject({ code: 'MALFORMED', workspaceId: null });
});
