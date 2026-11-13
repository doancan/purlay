import { describe, expect, test } from 'bun:test';
import { Value } from '@sinclair/typebox/value';
import {
  AddManualWorkspaceAccessRequest,
  AssignWorkspaceAccessGrantRequest,
  CHANNEL_ACCESS_ACTIONS,
  ConfirmWorkspaceOffboardingRequest,
  CreateWorkspaceAccessGroupRequest,
  CreateWorkspaceAccessRoleRequest,
  ProvisioningRevisionRequest,
  ReadmitWorkspaceMemberRequest,
  UpdateWorkspaceAccessGroupRequest,
  UpdateWorkspaceAccessRoleRequest,
  UpdateWorkspaceGroupMembersRequest,
  WORKSPACE_ACCESS_ACTIONS,
  WORKSPACE_ACCESS_BATCH_MAX,
  WORKSPACE_ACCESS_NAME_MAX,
  WorkspaceAccessListQuery,
  WorkspaceAccessGrantQuery,
  WorkspaceMemberAccess,
} from './workspace-provisioning';
import { statusFor } from './errors';

const revision = crypto.randomUUID();
const sourceId = crypto.randomUUID();
const groupId = crypto.randomUUID();
const roleId = crypto.randomUUID();
const channelId = crypto.randomUUID();

describe('workspace provisioning contracts', () => {
  test('custom roles accept the five explicit workspace/channel actions and no global privilege', () => {
    expect(
      Value.Check(CreateWorkspaceAccessRoleRequest, {
        name: 'İnsan Kaynakları',
        capabilities: [...WORKSPACE_ACCESS_ACTIONS, ...CHANNEL_ACCESS_ACTIONS],
      }),
    ).toBe(true);
    for (const capability of [
      'owner',
      'admin',
      'server.admin',
      'credentials.manage',
      'security.policy.write',
      'channel.messages.read',
      'unknown',
    ])
      expect(
        Value.Check(CreateWorkspaceAccessRoleRequest, {
          name: 'Privileged',
          capabilities: [capability],
        }),
      ).toBe(false);
    for (const capabilities of [[], ['audit.read', 'audit.read'], Array(6).fill('audit.read')])
      expect(Value.Check(CreateWorkspaceAccessRoleRequest, { name: 'Audit', capabilities })).toBe(
        false,
      );
  });

  test('role and group names stay bounded while allowing ordinary business names', () => {
    for (const name of ['Muhasebe', 'Satış ve Destek', 'x'.repeat(WORKSPACE_ACCESS_NAME_MAX)])
      expect(Value.Check(CreateWorkspaceAccessGroupRequest, { name })).toBe(true);
    for (const name of ['', '  ', 'x'.repeat(WORKSPACE_ACCESS_NAME_MAX + 1), 4]) {
      expect(Value.Check(CreateWorkspaceAccessGroupRequest, { name })).toBe(false);
      expect(
        Value.Check(CreateWorkspaceAccessRoleRequest, { name, capabilities: ['audit.read'] }),
      ).toBe(false);
    }
    expect(
      Value.Check(CreateWorkspaceAccessGroupRequest, {
        name: 'Finance',
        kind: 'directory',
        directoryId: crypto.randomUUID(),
      }),
    ).toBe(false);
  });

  test('updates carry an observed revision and an actual change', () => {
    expect(Value.Check(UpdateWorkspaceAccessRoleRequest, { revision, name: 'Reviewer' })).toBe(
      true,
    );
    expect(
      Value.Check(UpdateWorkspaceAccessRoleRequest, {
        revision,
        capabilities: ['members.invite'],
      }),
    ).toBe(true);
    for (const value of [{}, { name: 'New' }, { revision }, { revision, nativeRole: 'owner' }])
      expect(Value.Check(UpdateWorkspaceAccessRoleRequest, value)).toBe(false);
    expect(Value.Check(UpdateWorkspaceAccessGroupRequest, { revision, name: 'New' })).toBe(true);
    expect(Value.Check(UpdateWorkspaceAccessGroupRequest, { name: 'New' })).toBe(false);
  });

  test('group membership changes name admission sources with bounded unique operations', () => {
    for (const changes of [{ addSourceIds: [sourceId] }, { removeSourceIds: [sourceId] }])
      expect(Value.Check(UpdateWorkspaceGroupMembersRequest, { revision, ...changes })).toBe(true);
    const maximum = Array.from({ length: WORKSPACE_ACCESS_BATCH_MAX }, () => crypto.randomUUID());
    expect(
      Value.Check(UpdateWorkspaceGroupMembersRequest, { revision, addSourceIds: maximum }),
    ).toBe(true);
    for (const value of [
      { revision },
      { revision, addSourceIds: [] },
      { revision, addSourceIds: [sourceId, sourceId] },
      { revision, addSourceIds: [...maximum, crypto.randomUUID()] },
      { revision, addSourceIds: ['not-a-source'] },
      { revision, userIds: [crypto.randomUUID()] },
      { addSourceIds: [sourceId] },
    ])
      expect(Value.Check(UpdateWorkspaceGroupMembersRequest, value)).toBe(false);
  });

  test('grants have one explicit source/group subject and one explicit workspace/channel scope', () => {
    for (const subject of [
      { kind: 'source', sourceId },
      { kind: 'group', groupId },
    ])
      for (const scope of [{ kind: 'workspace' }, { kind: 'channel', channelId }])
        expect(
          Value.Check(AssignWorkspaceAccessGrantRequest, {
            roleId,
            roleRevision: revision,
            subjectRevision: revision,
            subject,
            scope,
          }),
        ).toBe(true);
    const valid = {
      roleId,
      roleRevision: revision,
      subjectRevision: revision,
      subject: { kind: 'source', sourceId },
      scope: { kind: 'workspace' },
    };
    for (const changes of [
      { subject: { kind: 'source', sourceId, groupId } },
      { subject: { kind: 'user', userId: crypto.randomUUID() } },
      { scope: { kind: 'global' } },
      { scope: { kind: 'workspace', channelId } },
      { scope: { kind: 'channel' } },
      { subjectRevision: undefined },
      { roleRevision: undefined },
      { nativeRole: 'owner' },
      { externalId: 'a-provider-selected-person' },
    ])
      expect(Value.Check(AssignWorkspaceAccessGrantRequest, { ...valid, ...changes })).toBe(false);
  });

  test('offboarding and readmission require explicit confirmation and observed native state', () => {
    for (const schema of [ConfirmWorkspaceOffboardingRequest, ReadmitWorkspaceMemberRequest]) {
      expect(Value.Check(schema, { revision, confirm: true })).toBe(true);
      for (const value of [
        { revision },
        { revision, confirm: false },
        { confirm: true },
        { revision, confirm: true, clearDirectoryState: true },
        { revision, confirm: true, globalSuspension: true },
      ])
        expect(Value.Check(schema, value)).toBe(false);
    }
    expect(Value.Check(ProvisioningRevisionRequest, { revision })).toBe(true);
    expect(Value.Check(AddManualWorkspaceAccessRequest, { revision, role: 'member' })).toBe(true);
    expect(
      Value.Check(AddManualWorkspaceAccessRequest, { revision, role: 'member', externalId: 'x' }),
    ).toBe(false);
  });

  test('member access reports only workspace capabilities and no permission-bearing directory claims', () => {
    const access = {
      userId: crypto.randomUUID(),
      revision,
      state: 'offboarded',
      role: null,
      accessKind: null,
      workspaceCapabilities: [],
      sources: [],
      groupCount: 0,
    };
    expect(Value.Check(WorkspaceMemberAccess, access)).toBe(true);
    expect(
      Value.Check(WorkspaceMemberAccess, {
        ...access,
        workspaceCapabilities: ['channel.members.manage'],
      }),
    ).toBe(false);
    for (const groupCount of [-1, 1.5])
      expect(Value.Check(WorkspaceMemberAccess, { ...access, groupCount })).toBe(false);
  });

  test('inventories retain bounded keyset paging and reject unowned query selectors', () => {
    expect(
      Value.Check(WorkspaceAccessListQuery, { before: sourceId, limit: 100, q: 'Satış' }),
    ).toBe(true);
    for (const value of [{ offset: 10 }, { limit: 101 }, { workspaceId: crypto.randomUUID() }])
      expect(Value.Check(WorkspaceAccessListQuery, value)).toBe(false);
    for (const query of [{}, { sourceId }, { groupId }, { sourceId, before: roleId, limit: 10 }])
      expect(Value.Check(WorkspaceAccessGrantQuery, query)).toBe(true);
    for (const query of [{ sourceId, groupId }, { sourceId: 'invalid' }, { externalId: 'x' }])
      expect(Value.Check(WorkspaceAccessGrantQuery, query)).toBe(false);
  });

  test('source/resource absence remains private while stale or managed state is a conflict', () => {
    for (const code of [
      'WORKSPACE_ACCESS_SOURCE_NOT_FOUND',
      'WORKSPACE_ACCESS_ROLE_NOT_FOUND',
      'WORKSPACE_ACCESS_GROUP_NOT_FOUND',
    ] as const)
      expect(statusFor(code)).toBe(404);
    for (const code of [
      'WORKSPACE_PROVISIONING_CHANGED',
      'WORKSPACE_PROVISIONING_NOT_READY',
      'WORKSPACE_MEMBERSHIP_MANAGED',
    ] as const)
      expect(statusFor(code)).toBe(409);
  });
});
