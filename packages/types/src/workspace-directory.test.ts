import { describe, expect, test } from 'bun:test';
import { Value } from '@sinclair/typebox/value';
import {
  CreateWorkspaceDirectoryRequest,
  UpdateWorkspaceDirectoryRequest,
  RotateDirectoryCredentialRequest,
  RevokeDirectoryCredentialRequest,
} from './workspace-directory';
const id = '11111111-1111-4111-8111-111111111111';
describe('workspace directory contracts', () => {
  test('only explicit verified claim mappings and admission intent can configure a directory', () => {
    const input = { name: 'Office', connectionId: id, claim: 'sub', allowCreate: false };
    expect(Value.Check(CreateWorkspaceDirectoryRequest, input)).toBe(true);
    for (const change of [
      { claim: 'email' },
      { claim: 'userName' },
      { externalId: 'guessed' },
      { userId: id },
      { name: ' ' },
    ])
      expect(Value.Check(CreateWorkspaceDirectoryRequest, { ...input, ...change })).toBe(false);
    expect(Value.Check(CreateWorkspaceDirectoryRequest, { ...input, claim: 'oid' })).toBe(true);
    expect(Value.Check(UpdateWorkspaceDirectoryRequest, { revision: id })).toBe(false);
    expect(Value.Check(UpdateWorkspaceDirectoryRequest, { revision: id, claim: 'email' })).toBe(
      false,
    );
    expect(Value.Check(UpdateWorkspaceDirectoryRequest, { revision: id, enabled: false })).toBe(
      true,
    );
  });
  test('credential rotation is revisioned and bounded, and revocation names the exact credential', () => {
    const input = { revision: id, expiresInDays: 30, overlapMinutes: 15 };
    expect(Value.Check(RotateDirectoryCredentialRequest, input)).toBe(true);
    for (const change of [
      { expiresInDays: 0 },
      { expiresInDays: 366 },
      { overlapMinutes: -1 },
      { overlapMinutes: 1441 },
      { token: 'caller chosen' },
    ])
      expect(Value.Check(RotateDirectoryCredentialRequest, { ...input, ...change })).toBe(false);
    expect(Value.Check(RevokeDirectoryCredentialRequest, { revision: id, credentialId: id })).toBe(
      true,
    );
    expect(Value.Check(RevokeDirectoryCredentialRequest, { revision: id, token: 'secret' })).toBe(
      false,
    );
  });
});
