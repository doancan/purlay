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
  const invoke = async <A extends unknown[], T>(
    select: (api: CompanyIdentityApi) => (...input: A) => Promise<T>,
    args: A,
  ): Promise<T> =>
    await select((await import('./company-identity-requests')).createCompanyIdentityRequests(http))(
      ...args,
    );
  return {
    companyDomains: (...args) => invoke((api) => api.companyDomains, args),
    createCompanyDomain: (...args) => invoke((api) => api.createCompanyDomain, args),
    renewCompanyDomain: (...args) => invoke((api) => api.renewCompanyDomain, args),
    verifyCompanyDomain: (...args) => invoke((api) => api.verifyCompanyDomain, args),
    revokeCompanyDomain: (...args) => invoke((api) => api.revokeCompanyDomain, args),
    companyConnections: (...args) => invoke((api) => api.companyConnections, args),
    createCompanyConnection: (...args) => invoke((api) => api.createCompanyConnection, args),
    updateCompanyConnection: (...args) => invoke((api) => api.updateCompanyConnection, args),
    setCompanyConnectionEnabled: (...args) =>
      invoke((api) => api.setCompanyConnectionEnabled, args),
    deleteCompanyConnection: (...args) => invoke((api) => api.deleteCompanyConnection, args),
    myCompanyIdentities: (...args) => invoke((api) => api.myCompanyIdentities, args),
    unlinkCompanyIdentity: (...args) => invoke((api) => api.unlinkCompanyIdentity, args),
    startCompanyIdentity: (...args) => invoke((api) => api.startCompanyIdentity, args),
    companySignInOptions: (...args) => invoke((api) => api.companySignInOptions, args),
    signInWithCompany: (...args) => invoke((api) => api.signInWithCompany, args),
  };
};
