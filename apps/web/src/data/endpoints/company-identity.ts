/** The enterprise client is lazy so configuring identity never grows every chat cold load. */
import type { OlderPageQuery } from '@purlay/types';
import type {
  CompanyIdentityConnection,
  CompanyIdentityConnectionPage,
  CompanyIdentityDomain,
  CompanyIdentityDomainPage,
  CompanyIdentityStarted,
  CompanySignInOptions,
  MyCompanyIdentityPage,
  CompanyIdentityStartRequest,
  CompanySignInRequest,
  CreateCompanyConnectionRequest,
  CreateCompanyDomainRequest,
  UpdateCompanyConnectionRequest,
} from '@purlay/types/workspace-identity';
import type { Http } from '../http';

export interface CompanyIdentityApi {
  readonly companyDomains: (
    workspaceId: string,
    signal?: AbortSignal,
  ) => Promise<CompanyIdentityDomainPage>;
  readonly createCompanyDomain: (
    workspaceId: string,
    input: CreateCompanyDomainRequest,
  ) => Promise<CompanyIdentityDomain>;
  readonly renewCompanyDomain: (
    workspaceId: string,
    domainId: string,
    revision: string,
  ) => Promise<CompanyIdentityDomain>;
  readonly verifyCompanyDomain: (
    workspaceId: string,
    domainId: string,
    revision: string,
  ) => Promise<CompanyIdentityDomain>;
  readonly revokeCompanyDomain: (
    workspaceId: string,
    domainId: string,
    revision: string,
  ) => Promise<void>;
  readonly companyConnections: (
    workspaceId: string,
    signal?: AbortSignal,
  ) => Promise<CompanyIdentityConnectionPage>;
  readonly createCompanyConnection: (
    workspaceId: string,
    input: CreateCompanyConnectionRequest,
  ) => Promise<CompanyIdentityConnection>;
  readonly updateCompanyConnection: (
    workspaceId: string,
    connectionId: string,
    input: UpdateCompanyConnectionRequest,
  ) => Promise<CompanyIdentityConnection>;
  readonly setCompanyConnectionEnabled: (
    workspaceId: string,
    connectionId: string,
    revision: string,
    enabled: boolean,
  ) => Promise<CompanyIdentityConnection>;
  readonly deleteCompanyConnection: (
    workspaceId: string,
    connectionId: string,
    revision: string,
  ) => Promise<void>;
  readonly myCompanyIdentities: (
    workspaceId: string,
    query?: OlderPageQuery,
    signal?: AbortSignal,
  ) => Promise<MyCompanyIdentityPage>;
  readonly unlinkCompanyIdentity: (
    workspaceId: string,
    connectionId: string,
    bindingId: string,
  ) => Promise<void>;
  readonly startCompanyIdentity: (
    input: CompanyIdentityStartRequest,
  ) => Promise<CompanyIdentityStarted>;
  readonly companySignInOptions: (
    workspace: string,
    signal?: AbortSignal,
  ) => Promise<CompanySignInOptions>;
  readonly signInWithCompany: (input: CompanySignInRequest) => Promise<CompanyIdentityStarted>;
}

export const createCompanyIdentityApi = (http: Http): CompanyIdentityApi => {
  const lazy =
    <A extends unknown[], T>(
      select: (api: CompanyIdentityApi) => (...input: A) => Promise<T>,
    ): ((...args: A) => Promise<T>) =>
    async (...args) =>
      await select(
        (await import('./company-identity-requests')).createCompanyIdentityRequests(http),
      )(...args);
  return {
    companyDomains: lazy((api) => api.companyDomains),
    createCompanyDomain: lazy((api) => api.createCompanyDomain),
    renewCompanyDomain: lazy((api) => api.renewCompanyDomain),
    verifyCompanyDomain: lazy((api) => api.verifyCompanyDomain),
    revokeCompanyDomain: lazy((api) => api.revokeCompanyDomain),
    companyConnections: lazy((api) => api.companyConnections),
    createCompanyConnection: lazy((api) => api.createCompanyConnection),
    updateCompanyConnection: lazy((api) => api.updateCompanyConnection),
    setCompanyConnectionEnabled: lazy((api) => api.setCompanyConnectionEnabled),
    deleteCompanyConnection: lazy((api) => api.deleteCompanyConnection),
    myCompanyIdentities: lazy((api) => api.myCompanyIdentities),
    unlinkCompanyIdentity: lazy((api) => api.unlinkCompanyIdentity),
    startCompanyIdentity: lazy((api) => api.startCompanyIdentity),
    companySignInOptions: lazy((api) => api.companySignInOptions),
    signInWithCompany: lazy((api) => api.signInWithCompany),
  };
};
