/** Company identity requests and their runtime decoders load only when this feature is used. */
import { AUTH_BASE_PATH } from '@purlay/types';
import {
  CompanyIdentityConnection,
  CompanyIdentityConnectionPage,
  CompanyIdentityDomain,
  CompanyIdentityDomainPage,
  CompanyIdentityStarted,
  CompanySignInOptions,
  MyCompanyIdentityPage,
} from '@purlay/types/workspace-identity';
import type { Http } from '../http';
import type { CompanyIdentityApi } from './company-identity';
import { at, options } from './request';

const root = (workspaceId: string): string => `/api/workspaces/${at(workspaceId)}/identity`;

export const createCompanyIdentityRequests = (http: Http): CompanyIdentityApi => ({
  companyDomains: (workspaceId, signal) =>
    http.request(
      'GET',
      `${root(workspaceId)}/domains`,
      CompanyIdentityDomainPage,
      options({}, signal),
    ),
  createCompanyDomain: (workspaceId, input) =>
    http.request(
      'POST',
      `${root(workspaceId)}/domains`,
      CompanyIdentityDomain,
      options({ body: input }),
    ),
  renewCompanyDomain: (workspaceId, domainId, revision) =>
    http.request(
      'POST',
      `${root(workspaceId)}/domains/${at(domainId)}/renew`,
      CompanyIdentityDomain,
      options({ body: { revision } }),
    ),
  verifyCompanyDomain: (workspaceId, domainId, revision) =>
    http.request(
      'POST',
      `${root(workspaceId)}/domains/${at(domainId)}/verify`,
      CompanyIdentityDomain,
      options({ body: { revision } }),
    ),
  revokeCompanyDomain: (workspaceId, domainId, revision) =>
    http.send(
      'DELETE',
      `${root(workspaceId)}/domains/${at(domainId)}`,
      options({ body: { revision } }),
    ),
  companyConnections: (workspaceId, signal) =>
    http.request(
      'GET',
      `${root(workspaceId)}/connections`,
      CompanyIdentityConnectionPage,
      options({}, signal),
    ),
  createCompanyConnection: (workspaceId, input) =>
    http.request(
      'POST',
      `${root(workspaceId)}/connections`,
      CompanyIdentityConnection,
      options({ body: input }),
    ),
  updateCompanyConnection: (workspaceId, connectionId, input) =>
    http.request(
      'PATCH',
      `${root(workspaceId)}/connections/${at(connectionId)}`,
      CompanyIdentityConnection,
      options({ body: input }),
    ),
  setCompanyConnectionEnabled: (workspaceId, connectionId, revision, enabled) =>
    http.request(
      'PUT',
      `${root(workspaceId)}/connections/${at(connectionId)}/enabled`,
      CompanyIdentityConnection,
      options({ body: { revision, enabled } }),
    ),
  deleteCompanyConnection: (workspaceId, connectionId, revision) =>
    http.send(
      'DELETE',
      `${root(workspaceId)}/connections/${at(connectionId)}`,
      options({ body: { revision } }),
    ),
  myCompanyIdentities: (workspaceId, query = {}, signal) =>
    http.request(
      'GET',
      `/api/workspaces/${at(workspaceId)}/company-identities`,
      MyCompanyIdentityPage,
      options({ query }, signal),
    ),
  unlinkCompanyIdentity: (workspaceId, connectionId, bindingId) =>
    http.send(
      'DELETE',
      `/api/workspaces/${at(workspaceId)}/company-identities/${at(connectionId)}`,
      options({ body: { bindingId } }),
    ),
  startCompanyIdentity: (input) =>
    http.libraryRequest(`${AUTH_BASE_PATH}/company/start`, CompanyIdentityStarted, input),
  companySignInOptions: (workspace, signal) =>
    http.request(
      'GET',
      `${AUTH_BASE_PATH}/company-options`,
      CompanySignInOptions,
      options({ query: { workspace } }, signal),
    ),
  signInWithCompany: (input) =>
    http.libraryRequest(`${AUTH_BASE_PATH}/company/sign-in`, CompanyIdentityStarted, input),
});
