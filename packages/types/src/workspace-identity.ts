/** Workspace-owned company identity uses the existing user, session and membership authority. */
import { Type, type Static } from '@sinclair/typebox';
import { FromClient, Timestamp, Uuid } from './models';
import {
  CreateWorkspaceRequest,
  OIDC_CLIENT_ID_MAX,
  OIDC_CLIENT_SECRET_MAX,
  OIDC_ISSUER_MAX,
  OIDC_NAME_MAX,
  Page,
} from './api';

/** Bound configuration inventories independently of the growing employee and audit directories. */
export const COMPANY_CONNECTIONS_MAX = 16;
export const COMPANY_DOMAINS_MAX = 32;
export const COMPANY_DOMAIN_MAX = 253;
export const COMPANY_DOMAIN_CHALLENGE_SECONDS = 24 * 60 * 60;

const connectionFields = {
  name: /* @__PURE__ */ Type.String({ minLength: 1, maxLength: OIDC_NAME_MAX }),
  domainId: Uuid,
  issuer: /* @__PURE__ */ Type.String({ minLength: 1, maxLength: OIDC_ISSUER_MAX }),
  clientId: /* @__PURE__ */ Type.String({ minLength: 1, maxLength: OIDC_CLIENT_ID_MAX }),
};
const clientSecret = /* @__PURE__ */ Type.String({
  minLength: 1,
  maxLength: OIDC_CLIENT_SECRET_MAX,
});

/** A pasted secret is write-only; workspace and canonical user are always obtained on the server. */
export const CreateCompanyConnectionRequest = /* @__PURE__ */ FromClient({
  ...connectionFields,
  clientSecret,
});
export type CreateCompanyConnectionRequest = Static<typeof CreateCompanyConnectionRequest>;

/** Omitting a secret preserves it. A stale form cannot overwrite a later configuration revision. */
export const UpdateCompanyConnectionRequest = /* @__PURE__ */ FromClient(
  {
    revision: Uuid,
    name: /* @__PURE__ */ Type.Optional(connectionFields.name),
    domainId: /* @__PURE__ */ Type.Optional(connectionFields.domainId),
    issuer: /* @__PURE__ */ Type.Optional(connectionFields.issuer),
    clientId: /* @__PURE__ */ Type.Optional(connectionFields.clientId),
    clientSecret: /* @__PURE__ */ Type.Optional(clientSecret),
  },
  { minProperties: 2 },
);
export type UpdateCompanyConnectionRequest = Static<typeof UpdateCompanyConnectionRequest>;

export const SetCompanyConnectionEnabledRequest = /* @__PURE__ */ FromClient({
  revision: Uuid,
  enabled: /* @__PURE__ */ Type.Boolean(),
});
export type SetCompanyConnectionEnabledRequest = Static<typeof SetCompanyConnectionEnabledRequest>;

/** A browser round trip proves the configured client; discovery alone cannot certify credentials. */
const identityStartFields = {
  revision: Uuid,
  intent: /* @__PURE__ */ Type.Union([
    /* @__PURE__ */ Type.Literal('test'),
    /* @__PURE__ */ Type.Literal('link'),
  ]),
};
export const StartCompanyIdentityRequest = /* @__PURE__ */ FromClient(identityStartFields);
export type StartCompanyIdentityRequest = Static<typeof StartCompanyIdentityRequest>;

export const UnlinkCompanyIdentityRequest = /* @__PURE__ */ FromClient({ bindingId: Uuid });
export type UnlinkCompanyIdentityRequest = Static<typeof UnlinkCompanyIdentityRequest>;

export const CreateCompanyDomainRequest = /* @__PURE__ */ FromClient({
  domain: /* @__PURE__ */ Type.String({ minLength: 1, maxLength: COMPANY_DOMAIN_MAX }),
});
export type CreateCompanyDomainRequest = Static<typeof CreateCompanyDomainRequest>;

/** An older verification or removal request cannot consume its replacement DNS challenge. */
export const CompanyIdentityRevisionRequest = /* @__PURE__ */ FromClient({ revision: Uuid });
export type CompanyIdentityRevisionRequest = Static<typeof CompanyIdentityRevisionRequest>;

export const CompanyIdentityConnection = /* @__PURE__ */ Type.Object({
  id: Uuid,
  revision: Uuid,
  ...connectionFields,
  enabled: /* @__PURE__ */ Type.Boolean(),
  secretConfigured: /* @__PURE__ */ Type.Boolean(),
  /** Both the linked domain and the current authentication configuration have been proved. */
  ready: /* @__PURE__ */ Type.Boolean(),
  testedAt: /* @__PURE__ */ Type.Union([Timestamp, /* @__PURE__ */ Type.Null()]),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type CompanyIdentityConnection = Static<typeof CompanyIdentityConnection>;

export const CompanyIdentityConnectionPage = /* @__PURE__ */ Page(CompanyIdentityConnection);
export type CompanyIdentityConnectionPage = Static<typeof CompanyIdentityConnectionPage>;

export const CompanyIdentityDomain = /* @__PURE__ */ Type.Object({
  id: Uuid,
  revision: Uuid,
  domain: /* @__PURE__ */ Type.String({ minLength: 1, maxLength: COMPANY_DOMAIN_MAX }),
  state: /* @__PURE__ */ Type.Union([
    /* @__PURE__ */ Type.Literal('pending'),
    /* @__PURE__ */ Type.Literal('verified'),
    /* @__PURE__ */ Type.Literal('expired'),
  ]),
  /** An intentional public DNS proof, visible to administrators; never an OAuth credential. */
  dnsRecord: /* @__PURE__ */ Type.Union([
    /* @__PURE__ */ Type.Object({
      type: /* @__PURE__ */ Type.Literal('TXT'),
      name: /* @__PURE__ */ Type.String(),
      value: /* @__PURE__ */ Type.String(),
    }),
    /* @__PURE__ */ Type.Null(),
  ]),
  challengeExpiresAt: Timestamp,
  verifiedAt: /* @__PURE__ */ Type.Union([Timestamp, /* @__PURE__ */ Type.Null()]),
  createdAt: Timestamp,
});
export type CompanyIdentityDomain = Static<typeof CompanyIdentityDomain>;

export const CompanyIdentityDomainPage = /* @__PURE__ */ Page(CompanyIdentityDomain);
export type CompanyIdentityDomainPage = Static<typeof CompanyIdentityDomainPage>;

/** Own bindings only: no directory subject, another person's email or provider token is exposed. */
export const MyCompanyIdentity = /* @__PURE__ */ Type.Object({
  connectionId: Uuid,
  revision: Uuid,
  name: /* @__PURE__ */ Type.String(),
  available: /* @__PURE__ */ Type.Boolean(),
  bindingId: /* @__PURE__ */ Type.Union([Uuid, /* @__PURE__ */ Type.Null()]),
  linkedAt: /* @__PURE__ */ Type.Union([Timestamp, /* @__PURE__ */ Type.Null()]),
});
export type MyCompanyIdentity = Static<typeof MyCompanyIdentity>;
export const MyCompanyIdentityPage = /* @__PURE__ */ Page(MyCompanyIdentity);
export type MyCompanyIdentityPage = Static<typeof MyCompanyIdentityPage>;

export const CompanyIdentityStarted = /* @__PURE__ */ Type.Object({
  url: /* @__PURE__ */ Type.String({ format: 'uri', pattern: '^https://' }),
});
export type CompanyIdentityStarted = Static<typeof CompanyIdentityStarted>;

/** Exact workspace lookup, never a public workspace or employee directory. */
const companySignInFields = {
  workspace: CreateWorkspaceRequest.properties.slug,
};
export const CompanySignInQuery = /* @__PURE__ */ FromClient(companySignInFields);
export type CompanySignInQuery = Static<typeof CompanySignInQuery>;

export const CompanySignInOptions = /* @__PURE__ */ Type.Object({
  workspace: CreateWorkspaceRequest.properties.slug,
  connections: /* @__PURE__ */ Type.Array(
    /* @__PURE__ */ Type.Object({ id: Uuid, name: /* @__PURE__ */ Type.String() }),
    { maxItems: COMPANY_CONNECTIONS_MAX },
  ),
});
export type CompanySignInOptions = Static<typeof CompanySignInOptions>;

export const CompanyIdentityStartRequest = /* @__PURE__ */ FromClient({
  workspaceId: Uuid,
  connectionId: Uuid,
  ...identityStartFields,
});
export type CompanyIdentityStartRequest = Static<typeof CompanyIdentityStartRequest>;

export const CompanySignInRequest = /* @__PURE__ */ FromClient({
  ...companySignInFields,
  connectionId: Uuid,
});
export type CompanySignInRequest = Static<typeof CompanySignInRequest>;

/** Written only in Better Auth's authenticated serverContext, never read from client additionalData. */
export const CompanyIdentityFlowState = /* @__PURE__ */ FromClient({
  workspaceId: Uuid,
  connectionId: Uuid,
  revision: Uuid,
  authenticationRevision: Uuid,
  intent: /* @__PURE__ */ Type.Union([
    /* @__PURE__ */ Type.Literal('test'),
    /* @__PURE__ */ Type.Literal('link'),
    /* @__PURE__ */ Type.Literal('sign-in'),
  ]),
  userId: /* @__PURE__ */ Type.Union([Uuid, /* @__PURE__ */ Type.Null()]),
  sessionId: /* @__PURE__ */ Type.Union([Uuid, /* @__PURE__ */ Type.Null()]),
});
export type CompanyIdentityFlowState = Static<typeof CompanyIdentityFlowState>;

export const CompanyIdentityCallbackQuery = /* @__PURE__ */ FromClient({
  state: /* @__PURE__ */ Type.String({ minLength: 1, maxLength: 1024 }),
  code: /* @__PURE__ */ Type.Optional(
    /* @__PURE__ */ Type.String({ minLength: 1, maxLength: 4096 }),
  ),
  iss: /* @__PURE__ */ Type.Optional(/* @__PURE__ */ Type.String({ maxLength: OIDC_ISSUER_MAX })),
  error: /* @__PURE__ */ Type.Optional(/* @__PURE__ */ Type.String({ maxLength: 128 })),
  error_description: /* @__PURE__ */ Type.Optional(
    /* @__PURE__ */ Type.String({ maxLength: 1024 }),
  ),
});
export type CompanyIdentityCallbackQuery = Static<typeof CompanyIdentityCallbackQuery>;

/** Canonical DNS identity, shared by forms, storage and proof. Ownership is checked separately. */
export const normalisedCompanyDomain = (input: string): string | undefined => {
  const given = input.trim();
  if (given === '' || /[\s\p{Cc}\p{Cf}\p{Zl}\p{Zp}/?:#@\\]/u.test(given)) return undefined;
  let hostname: string;
  try {
    hostname = new URL(`https://${given}`).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  const domain = hostname.endsWith('.') ? hostname.slice(0, -1) : hostname;
  const labels = domain.split('.');
  if (
    domain.length > COMPANY_DOMAIN_MAX ||
    labels.length < 2 ||
    !/[a-z]/.test(labels.at(-1) ?? '') ||
    labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  )
    return undefined;
  return domain;
};
