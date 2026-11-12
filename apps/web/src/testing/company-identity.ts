/** Company fixtures contain public connection metadata, never stored credentials. */
import type { AuthMethods } from '@purlay/types';
import type {
  CompanyIdentityConnection,
  CompanyIdentityDomain,
} from '@purlay/types/workspace-identity';
import { IDS, WHEN } from './fixtures';

export const COMPANY_METHODS: AuthMethods = {
  github: false,
  email: false,
  oidc: null,
  google: false,
  signUp: 'invite-only',
  password: true,
  company: { callbackUrl: 'https://purlay.test/auth/company/callback' },
};

export const COMPANY_DOMAIN: CompanyIdentityDomain = {
  id: IDS.api,
  revision: IDS.alice,
  domain: 'acme.example',
  state: 'verified',
  dnsRecord: null,
  challengeExpiresAt: WHEN,
  verifiedAt: WHEN,
  createdAt: WHEN,
};

export const COMPANY_CONNECTION: CompanyIdentityConnection = {
  id: IDS.deploys,
  revision: IDS.bob,
  domainId: COMPANY_DOMAIN.id,
  name: 'Office',
  issuer: 'https://identity.example',
  clientId: 'office-client',
  secretConfigured: true,
  ready: false,
  enabled: false,
  testedAt: null,
  createdAt: WHEN,
  updatedAt: WHEN,
};
