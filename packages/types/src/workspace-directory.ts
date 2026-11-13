/** Directory credentials are shown once; mappings always name an exact verified company claim. */
import { Type, type Static } from '@sinclair/typebox';
import { FromClient, Timestamp, Uuid } from './models';
import { Page } from './api';

export const WORKSPACE_DIRECTORIES_MAX = 8;
export const DIRECTORY_CREDENTIALS_MAX = 5;
/** All five live credentials plus the five most recent expired/revoked metadata rows. */
export const DIRECTORY_CREDENTIAL_METADATA_MAX = 10;
export const DIRECTORY_EXTERNAL_ID_MAX = 255;
export const DirectoryIdentityClaim = /* @__PURE__ */ Type.Union([
  /* @__PURE__ */ Type.Literal('sub'),
  /* @__PURE__ */ Type.Literal('oid'),
]);
export type DirectoryIdentityClaim = Static<typeof DirectoryIdentityClaim>;
const name = /* @__PURE__ */ Type.String({ minLength: 1, maxLength: 64, pattern: '\\S' });
export const DirectoryCredential = /* @__PURE__ */ Type.Object({
  id: Uuid,
  createdAt: Timestamp,
  expiresAt: Timestamp,
  revokedAt: /* @__PURE__ */ Type.Union([Timestamp, /* @__PURE__ */ Type.Null()]),
  lastUsedAt: /* @__PURE__ */ Type.Union([Timestamp, /* @__PURE__ */ Type.Null()]),
});
export type DirectoryCredential = Static<typeof DirectoryCredential>;
export const WorkspaceDirectory = /* @__PURE__ */ Type.Object({
  id: Uuid,
  revision: Uuid,
  name,
  enabled: /* @__PURE__ */ Type.Boolean(),
  allowCreate: /* @__PURE__ */ Type.Boolean(),
  connectionId: Uuid,
  claim: DirectoryIdentityClaim,
  scimUrl: /* @__PURE__ */ Type.String({ format: 'uri' }),
  credentials: /* @__PURE__ */ Type.Array(DirectoryCredential, {
    maxItems: DIRECTORY_CREDENTIAL_METADATA_MAX,
  }),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type WorkspaceDirectory = Static<typeof WorkspaceDirectory>;
export const WorkspaceDirectoryPage = /* @__PURE__ */ Page(WorkspaceDirectory);
export type WorkspaceDirectoryPage = Static<typeof WorkspaceDirectoryPage>;
export const CreateWorkspaceDirectoryRequest = /* @__PURE__ */ FromClient({
  name,
  connectionId: Uuid,
  claim: DirectoryIdentityClaim,
  allowCreate: /* @__PURE__ */ Type.Boolean(),
});
export type CreateWorkspaceDirectoryRequest = Static<typeof CreateWorkspaceDirectoryRequest>;
export const UpdateWorkspaceDirectoryRequest = /* @__PURE__ */ FromClient(
  {
    revision: Uuid,
    name: /* @__PURE__ */ Type.Optional(name),
    enabled: /* @__PURE__ */ Type.Optional(/* @__PURE__ */ Type.Boolean()),
    allowCreate: /* @__PURE__ */ Type.Optional(/* @__PURE__ */ Type.Boolean()),
  },
  { minProperties: 2 },
);
export type UpdateWorkspaceDirectoryRequest = Static<typeof UpdateWorkspaceDirectoryRequest>;
export const RotateDirectoryCredentialRequest = /* @__PURE__ */ FromClient({
  revision: Uuid,
  expiresInDays: /* @__PURE__ */ Type.Integer({ minimum: 1, maximum: 365 }),
  overlapMinutes: /* @__PURE__ */ Type.Integer({ minimum: 0, maximum: 1440 }),
});
export type RotateDirectoryCredentialRequest = Static<typeof RotateDirectoryCredentialRequest>;
export const RevokeDirectoryCredentialRequest = /* @__PURE__ */ FromClient({
  revision: Uuid,
  credentialId: Uuid,
});
export type RevokeDirectoryCredentialRequest = Static<typeof RevokeDirectoryCredentialRequest>;
export const DirectoryRevisionRequest = /* @__PURE__ */ FromClient({ revision: Uuid });
export type DirectoryRevisionRequest = Static<typeof DirectoryRevisionRequest>;
/** The only response carrying a bearer secret; subsequent reads expose metadata alone. */
export const IssuedDirectoryCredential = /* @__PURE__ */ Type.Object({
  directory: WorkspaceDirectory,
  credential: DirectoryCredential,
  token: /* @__PURE__ */ Type.String({ minLength: 96, maxLength: 160 }),
});
export type IssuedDirectoryCredential = Static<typeof IssuedDirectoryCredential>;
