/** Workspace-scoped access administration never grants global credential or private-chat authority. */
import { Type, type Static } from '@sinclair/typebox';
import {
  ChannelAccessAction,
  FromClient,
  Timestamp,
  User,
  UserRole,
  Uuid,
  WorkspaceAccessAction,
} from './models';
import { OlderPageQuery, Page } from './api';

export const WORKSPACE_ACCESS_NAME_MAX = 64;
export const WORKSPACE_ACCESS_BATCH_MAX = 100;
export const WORKSPACE_ACCESS_SOURCES_MAX = 17;

export const WORKSPACE_ACCESS_ACTIONS = [
  'members.invite',
  'members.manage_nonowners',
  'audit.read',
] as const;
export const CHANNEL_ACCESS_ACTIONS = [
  'channel.settings.manage',
  'channel.members.manage',
] as const;

export { WorkspaceAccessAction, ChannelAccessAction };
export const WorkspaceScopedCapability = /* @__PURE__ */ Type.Union([
  WorkspaceAccessAction,
  ChannelAccessAction,
]);
export type WorkspaceScopedCapability = Static<typeof WorkspaceScopedCapability>;

const name = /* @__PURE__ */ Type.String({
  minLength: 1,
  maxLength: WORKSPACE_ACCESS_NAME_MAX,
  pattern: '\\S',
});
const capabilities = /* @__PURE__ */ Type.Array(WorkspaceScopedCapability, {
  minItems: 1,
  maxItems: WORKSPACE_ACCESS_ACTIONS.length + CHANNEL_ACCESS_ACTIONS.length,
  uniqueItems: true,
});
const sourceIds = /* @__PURE__ */ Type.Array(Uuid, {
  minItems: 1,
  maxItems: WORKSPACE_ACCESS_BATCH_MAX,
  uniqueItems: true,
});
const count = /* @__PURE__ */ Type.Integer({ minimum: 0 });

export const ProvisioningRevisionRequest = /* @__PURE__ */ FromClient({ revision: Uuid });
export type ProvisioningRevisionRequest = Static<typeof ProvisioningRevisionRequest>;
export const WorkspaceAccessListQuery = /* @__PURE__ */ FromClient({
  ...OlderPageQuery.properties,
  q: /* @__PURE__ */ Type.Optional(
    /* @__PURE__ */ Type.String({ maxLength: WORKSPACE_ACCESS_NAME_MAX }),
  ),
});
export type WorkspaceAccessListQuery = Static<typeof WorkspaceAccessListQuery>;

/** Source identity is server-owned; a label or an external subject is never a membership key. */
export const WorkspaceAccessSourceSummary = /* @__PURE__ */ Type.Object({
  id: Uuid,
  revision: Uuid,
  kind: /* @__PURE__ */ Type.Union([
    /* @__PURE__ */ Type.Literal('manual'),
    /* @__PURE__ */ Type.Literal('directory'),
  ]),
  state: /* @__PURE__ */ Type.Union([
    /* @__PURE__ */ Type.Literal('active'),
    /* @__PURE__ */ Type.Literal('inactive'),
    /* @__PURE__ */ Type.Literal('retired'),
  ]),
  builtinRole: UserRole,
  effective: /* @__PURE__ */ Type.Boolean(),
  name: /* @__PURE__ */ Type.Union([
    /* @__PURE__ */ Type.String({ minLength: 1, maxLength: 160 }),
    /* @__PURE__ */ Type.Null(),
  ]),
  directoryId: /* @__PURE__ */ Type.Union([Uuid, /* @__PURE__ */ Type.Null()]),
});
export type WorkspaceAccessSourceSummary = Static<typeof WorkspaceAccessSourceSummary>;

export const WorkspaceMemberAccess = /* @__PURE__ */ Type.Object({
  userId: Uuid,
  revision: Uuid,
  state: /* @__PURE__ */ Type.Union([
    /* @__PURE__ */ Type.Literal('active'),
    /* @__PURE__ */ Type.Literal('inactive'),
    /* @__PURE__ */ Type.Literal('offboarded'),
  ]),
  role: /* @__PURE__ */ Type.Union([UserRole, /* @__PURE__ */ Type.Null()]),
  accessKind: /* @__PURE__ */ Type.Union([
    /* @__PURE__ */ Type.Literal('member'),
    /* @__PURE__ */ Type.Literal('guest'),
    /* @__PURE__ */ Type.Null(),
  ]),
  workspaceCapabilities: /* @__PURE__ */ Type.Array(WorkspaceAccessAction, {
    maxItems: WORKSPACE_ACCESS_ACTIONS.length,
    uniqueItems: true,
  }),
  sources: /* @__PURE__ */ Type.Array(WorkspaceAccessSourceSummary, {
    maxItems: WORKSPACE_ACCESS_SOURCES_MAX,
  }),
  groupCount: count,
});
export type WorkspaceMemberAccess = Static<typeof WorkspaceMemberAccess>;
export const WorkspaceAccessPerson = /* @__PURE__ */ Type.Object({
  id: Uuid,
  user: User,
  access: WorkspaceMemberAccess,
});
export type WorkspaceAccessPerson = Static<typeof WorkspaceAccessPerson>;
export const WorkspaceAccessPeoplePage = /* @__PURE__ */ Page(WorkspaceAccessPerson);
export type WorkspaceAccessPeoplePage = Static<typeof WorkspaceAccessPeoplePage>;
export const WorkspaceAccessPeopleQuery = /* @__PURE__ */ FromClient({
  ...WorkspaceAccessListQuery.properties,
  state: /* @__PURE__ */ Type.Optional(
    /* @__PURE__ */ Type.Union([
      /* @__PURE__ */ Type.Literal('active'),
      /* @__PURE__ */ Type.Literal('inactive'),
      /* @__PURE__ */ Type.Literal('offboarded'),
    ]),
  ),
});
export type WorkspaceAccessPeopleQuery = Static<typeof WorkspaceAccessPeopleQuery>;

/** Custom roles contain only these actions; owner/admin remain separate native roles. */
export const CreateWorkspaceAccessRoleRequest = /* @__PURE__ */ FromClient({
  name,
  capabilities,
});
export type CreateWorkspaceAccessRoleRequest = Static<typeof CreateWorkspaceAccessRoleRequest>;
export const UpdateWorkspaceAccessRoleRequest = /* @__PURE__ */ FromClient(
  {
    revision: Uuid,
    name: /* @__PURE__ */ Type.Optional(name),
    capabilities: /* @__PURE__ */ Type.Optional(capabilities),
  },
  { minProperties: 2 },
);
export type UpdateWorkspaceAccessRoleRequest = Static<typeof UpdateWorkspaceAccessRoleRequest>;
export const WorkspaceAccessRole = /* @__PURE__ */ Type.Object({
  id: Uuid,
  revision: Uuid,
  name,
  capabilities,
  retiredAt: /* @__PURE__ */ Type.Union([Timestamp, /* @__PURE__ */ Type.Null()]),
});
export type WorkspaceAccessRole = Static<typeof WorkspaceAccessRole>;
export const WorkspaceAccessRolePage = /* @__PURE__ */ Page(WorkspaceAccessRole);
export type WorkspaceAccessRolePage = Static<typeof WorkspaceAccessRolePage>;

export const CreateWorkspaceAccessGroupRequest = /* @__PURE__ */ FromClient({ name });
export type CreateWorkspaceAccessGroupRequest = Static<typeof CreateWorkspaceAccessGroupRequest>;
export const UpdateWorkspaceAccessGroupRequest = /* @__PURE__ */ FromClient({
  revision: Uuid,
  name,
});
export type UpdateWorkspaceAccessGroupRequest = Static<typeof UpdateWorkspaceAccessGroupRequest>;
export const UpdateWorkspaceGroupMembersRequest = /* @__PURE__ */ FromClient(
  {
    revision: Uuid,
    addSourceIds: /* @__PURE__ */ Type.Optional(sourceIds),
    removeSourceIds: /* @__PURE__ */ Type.Optional(sourceIds),
  },
  { minProperties: 2 },
);
export type UpdateWorkspaceGroupMembersRequest = Static<typeof UpdateWorkspaceGroupMembersRequest>;
export const WorkspaceAccessGroup = /* @__PURE__ */ Type.Object({
  id: Uuid,
  revision: Uuid,
  name,
  kind: /* @__PURE__ */ Type.Union([
    /* @__PURE__ */ Type.Literal('manual'),
    /* @__PURE__ */ Type.Literal('directory'),
  ]),
  directoryId: /* @__PURE__ */ Type.Union([Uuid, /* @__PURE__ */ Type.Null()]),
  memberCount: count,
  retiredAt: /* @__PURE__ */ Type.Union([Timestamp, /* @__PURE__ */ Type.Null()]),
});
export type WorkspaceAccessGroup = Static<typeof WorkspaceAccessGroup>;
export const WorkspaceAccessGroupPage = /* @__PURE__ */ Page(WorkspaceAccessGroup);
export type WorkspaceAccessGroupPage = Static<typeof WorkspaceAccessGroupPage>;
export const WorkspaceAccessGroupMember = /* @__PURE__ */ Type.Object({
  id: Uuid,
  userId: Uuid,
  user: User,
  sourceId: Uuid,
  source: WorkspaceAccessSourceSummary,
  joinedAt: Timestamp,
});
export type WorkspaceAccessGroupMember = Static<typeof WorkspaceAccessGroupMember>;
export const WorkspaceAccessGroupMemberPage = /* @__PURE__ */ Page(WorkspaceAccessGroupMember);
export type WorkspaceAccessGroupMemberPage = Static<typeof WorkspaceAccessGroupMemberPage>;
/** Human-readable, source-specific choices are paged in one query, never per-person lookups. */
export const WorkspaceAccessGroupCandidate = /* @__PURE__ */ Type.Object({
  id: Uuid,
  user: User,
  source: WorkspaceAccessSourceSummary,
});
export type WorkspaceAccessGroupCandidate = Static<typeof WorkspaceAccessGroupCandidate>;
const candidateCursorPart =
  '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const candidateCursor = /* @__PURE__ */ Type.String({
  minLength: 73,
  maxLength: 73,
  pattern: `^${candidateCursorPart}:${candidateCursorPart}$`,
});
/** Person/source keyset keeps first-time legacy initialization bounded without losing a source. */
export const WorkspaceAccessGroupCandidateQuery = /* @__PURE__ */ FromClient({
  ...WorkspaceAccessListQuery.properties,
  before: /* @__PURE__ */ Type.Optional(candidateCursor),
});
export type WorkspaceAccessGroupCandidateQuery = Static<typeof WorkspaceAccessGroupCandidateQuery>;
export const WorkspaceAccessGroupCandidatePage = /* @__PURE__ */ Page(
  WorkspaceAccessGroupCandidate,
  candidateCursor,
);
export type WorkspaceAccessGroupCandidatePage = Static<typeof WorkspaceAccessGroupCandidatePage>;

const grantSubject = /* @__PURE__ */ Type.Union([
  /* @__PURE__ */ FromClient({ kind: /* @__PURE__ */ Type.Literal('source'), sourceId: Uuid }),
  /* @__PURE__ */ FromClient({ kind: /* @__PURE__ */ Type.Literal('group'), groupId: Uuid }),
]);
const grantScope = /* @__PURE__ */ Type.Union([
  /* @__PURE__ */ FromClient({ kind: /* @__PURE__ */ Type.Literal('workspace') }),
  /* @__PURE__ */ FromClient({ kind: /* @__PURE__ */ Type.Literal('channel'), channelId: Uuid }),
]);
/** A role grant targets an existing admission source or group; it never silently adds direct access. */
export const AssignWorkspaceAccessGrantRequest = /* @__PURE__ */ FromClient({
  roleId: Uuid,
  roleRevision: Uuid,
  subject: grantSubject,
  subjectRevision: Uuid,
  scope: grantScope,
});
export type AssignWorkspaceAccessGrantRequest = Static<typeof AssignWorkspaceAccessGrantRequest>;
export const WorkspaceAccessGrantQuery = /* @__PURE__ */ Type.Union([
  WorkspaceAccessListQuery,
  /* @__PURE__ */ FromClient({ ...WorkspaceAccessListQuery.properties, sourceId: Uuid }),
  /* @__PURE__ */ FromClient({ ...WorkspaceAccessListQuery.properties, groupId: Uuid }),
]);
export type WorkspaceAccessGrantQuery = Static<typeof WorkspaceAccessGrantQuery>;
export const WorkspaceAccessGrant = /* @__PURE__ */ Type.Object({
  id: Uuid,
  revision: Uuid,
  roleId: Uuid,
  role: WorkspaceAccessRole,
  subject: /* @__PURE__ */ Type.Union([
    /* @__PURE__ */ Type.Object({
      kind: /* @__PURE__ */ Type.Literal('source'),
      sourceId: Uuid,
      source: WorkspaceAccessSourceSummary,
      user: User,
    }),
    /* @__PURE__ */ Type.Object({
      kind: /* @__PURE__ */ Type.Literal('group'),
      groupId: Uuid,
      group: WorkspaceAccessGroup,
    }),
  ]),
  scope: /* @__PURE__ */ Type.Union([
    /* @__PURE__ */ Type.Object({ kind: /* @__PURE__ */ Type.Literal('workspace') }),
    /* @__PURE__ */ Type.Object({
      kind: /* @__PURE__ */ Type.Literal('channel'),
      channelId: Uuid,
      name: /* @__PURE__ */ Type.String({ minLength: 1, maxLength: 64 }),
      type: /* @__PURE__ */ Type.Union([
        /* @__PURE__ */ Type.Literal('public'),
        /* @__PURE__ */ Type.Literal('private'),
      ]),
    }),
  ]),
  createdAt: Timestamp,
});
export type WorkspaceAccessGrant = Static<typeof WorkspaceAccessGrant>;
export const WorkspaceAccessGrantPage = /* @__PURE__ */ Page(WorkspaceAccessGrant);
export type WorkspaceAccessGrantPage = Static<typeof WorkspaceAccessGrantPage>;

export const AddManualWorkspaceAccessRequest = /* @__PURE__ */ FromClient({
  revision: Uuid,
  role: UserRole,
});
export type AddManualWorkspaceAccessRequest = Static<typeof AddManualWorkspaceAccessRequest>;
export const RevokeWorkspaceAccessSourceRequest = /* @__PURE__ */ FromClient(
  ProvisioningRevisionRequest.properties,
);
export type RevokeWorkspaceAccessSourceRequest = Static<typeof RevokeWorkspaceAccessSourceRequest>;
export const PreviewWorkspaceOffboardingRequest = /* @__PURE__ */ FromClient(
  ProvisioningRevisionRequest.properties,
);
export type PreviewWorkspaceOffboardingRequest = Static<typeof PreviewWorkspaceOffboardingRequest>;
export const WorkspaceOffboardingPreview = /* @__PURE__ */ Type.Object({
  access: WorkspaceMemberAccess,
  affectedChannelCount: count,
  sourceSessionCount: count,
  canOffboard: /* @__PURE__ */ Type.Boolean(),
  reason: /* @__PURE__ */ Type.Union([
    /* @__PURE__ */ Type.Literal('last_owner'),
    /* @__PURE__ */ Type.Literal('protected_role'),
    /* @__PURE__ */ Type.Null(),
  ]),
});
export type WorkspaceOffboardingPreview = Static<typeof WorkspaceOffboardingPreview>;
export const ConfirmWorkspaceOffboardingRequest = /* @__PURE__ */ FromClient({
  revision: Uuid,
  confirm: /* @__PURE__ */ Type.Literal(true),
});
export type ConfirmWorkspaceOffboardingRequest = Static<typeof ConfirmWorkspaceOffboardingRequest>;
export const ReadmitWorkspaceMemberRequest = /* @__PURE__ */ FromClient({
  revision: Uuid,
  confirm: /* @__PURE__ */ Type.Literal(true),
});
export type ReadmitWorkspaceMemberRequest = Static<typeof ReadmitWorkspaceMemberRequest>;
