/** Strict OIDC plus Better Auth's native transaction/account/session/cookie path, with native membership as the authority. */
import {
  generateState,
  parseState,
  type BetterAuthPlugin,
  type StandardSchemaV1,
} from 'better-auth';
import { APIError, addOAuthServerContext, createAuthEndpoint } from 'better-auth/api';
import { generateIdTokenNonce, handleOAuthUserInfo } from 'better-auth/oauth2';
import { setSessionCookie } from 'better-auth/cookies';
import { getCurrentAdapter, runWithTransaction } from '@better-auth/core/context';
import { activeDirectoryIdentity, consentDirectoryIdentity } from '../directory/identity';
import { Value } from '@sinclair/typebox/value';
import type { Static, TSchema } from '@sinclair/typebox';
import { AUTH_BASE_PATH } from '@purlay/types';
import {
  CompanyIdentityCallbackQuery,
  CompanyIdentityFlowState,
  CompanyIdentityStartRequest,
  CompanySignInRequest,
} from '@purlay/types/workspace-identity';
import { atomicallyOn } from '../../../platform/transactions';
import { requireWorkspaceMembership } from '../../../platform/tenancy';
import type { Logger } from '../../../platform/logging';
import { AppError } from '../../../platform/errors';
import { createOidcProvider, type OidcFetch, type OidcProvider } from '../../auth/oidc';
import { heldTransaction } from '../../auth/sign-up-transaction';
import type { SessionOwner } from '../../auth/sessions';
import { recordPrimaryAuthentication } from '../../auth/authentication-evidence';
import { recordAudit } from '../../audit/audit';
import {
  identityChanged,
  identityNotReady,
  lockCompanyIdentityActor,
  lockCompanySignInMember,
  type CompanyIdentityDependencies,
} from './authority';
import {
  companyConnectionSnapshot,
  companyProviderId,
  matchCompanyIdentityFlow,
  type CompanyConnectionSnapshot,
} from './catalogue';
import {
  CompanyProviderTransportError,
  companyProviderAddress,
  companyProviderFetch,
} from './provider-fetch';

interface NativeCompanyIdentityDependencies extends CompanyIdentityDependencies {
  readonly baseUrl: string;
  readonly log: Logger;
  readonly providerFetch?: OidcFetch;
  readonly requireActor: (headers: Headers) => Promise<SessionOwner>;
}

/** The wire remains TypeBox-owned; Better Auth consumes its public Standard Schema contract. */
const nativeContract = <Schema extends TSchema>(
  schema: Schema,
): StandardSchemaV1<Static<Schema>> => ({
  '~standard': {
    version: 1,
    vendor: 'purlay-typebox',
    validate: (value) =>
      Value.Check(schema, value)
        ? { value }
        : { issues: [{ message: 'The request did not match the contract.' }] },
  },
});

/** Preserve Purlay's closed error codes at the library's own HTTP boundary. */
const companyAction = async <Result>(run: () => Promise<Result>): Promise<Result> => {
  try {
    return await run();
  } catch (error) {
    if (error instanceof CompanyProviderTransportError)
      throw new APIError('BAD_GATEWAY', {
        code: 'COMPANY_IDENTITY_UNAVAILABLE',
        message: 'The company identity provider could not be used.',
      });
    if (error instanceof AppError)
      throw new APIError(error.status, { code: error.body.code, message: error.body.message });
    throw error;
  }
};

export const companyIdentityPlugin = (
  dependencies: NativeCompanyIdentityDependencies,
): BetterAuthPlugin => {
  const callbackURI = `${dependencies.baseUrl}${AUTH_BASE_PATH}/company/callback`;
  const get = dependencies.providerFetch ?? companyProviderFetch();
  // Keep the verifier's discovery/JWKS reuse and refresh cooldown across callbacks. Authority is never cached.
  const providers = new Map<string, OidcProvider['provider']>();
  const providerOf = (snapshot: CompanyConnectionSnapshot): OidcProvider['provider'] => {
    const key = `${snapshot.id}:${snapshot.authenticationRevision}`;
    let provider = providers.get(key);
    providers.delete(key);
    provider ??= createOidcProvider(
      snapshot.credentials,
      snapshot.name,
      {
        fetch: get,
        clock: dependencies.clock,
        log: dependencies.log,
        onIdentity: (): void => undefined,
      },
      {
        id: companyProviderId(snapshot.id),
        acceptedIssuers: [],
        // The external key is resolved only from the separately verified profile below, never concatenated for account lookup.
        accountKey: (_issuer, subject) => subject,
        codes: {
          unavailable: 'COMPANY_IDENTITY_UNAVAILABLE',
          unverified: 'COMPANY_IDENTITY_UNVERIFIED',
        },
        messages: {
          unavailable: 'The company identity provider did not answer.',
          unverified: 'The company provider did not verify this address.',
        },
        logPrefix: 'company identity',
      },
    ).provider;
    providers.set(key, provider);
    if (providers.size > 32) {
      const oldest = providers.keys().next().value;
      if (oldest !== undefined) providers.delete(oldest);
    }
    return provider;
  };
  const requireNonce = (provider: OidcProvider['provider']): string => {
    const nonce = generateIdTokenNonce(provider);
    if (nonce === undefined) throw new Error('Company OIDC requires a nonce');
    return nonce;
  };
  const flowOf = (
    snapshot: CompanyConnectionSnapshot,
    intent: CompanyIdentityFlowState['intent'],
    actor?: SessionOwner,
  ): CompanyIdentityFlowState => ({
    workspaceId: snapshot.workspaceId,
    connectionId: snapshot.id,
    revision: snapshot.revision,
    authenticationRevision: snapshot.authenticationRevision,
    intent,
    userId: actor?.userId ?? null,
    sessionId: actor?.sessionId ?? null,
  });

  return {
    id: 'purlay-company-identity',
    endpoints: {
      companyIdentityStart: createAuthEndpoint(
        '/company/start',
        {
          method: 'POST',
          requireHeaders: true,
          body: nativeContract(CompanyIdentityStartRequest),
        },
        async (ctx) =>
          await companyAction(async () => {
            const actor = await dependencies.requireActor(ctx.headers);
            const context = await requireWorkspaceMembership(
              dependencies.database,
              actor.userId,
              ctx.body.workspaceId,
            );
            const snapshot = await atomicallyOn(dependencies.database)(async (transaction) => {
              await lockCompanyIdentityActor(
                transaction,
                dependencies,
                { context, sessionId: actor.sessionId },
                ctx.body.intent === 'test',
              );
              const current = await companyConnectionSnapshot(
                transaction,
                dependencies,
                ctx.body.connectionId,
                { workspaceId: context.workspaceId },
                ctx.body.intent !== 'test',
              );
              if (current.revision !== ctx.body.revision) throw identityChanged();
              return current;
            });
            await addOAuthServerContext({
              companyIdentity: flowOf(snapshot, ctx.body.intent, actor),
            });
            const provider = providerOf(snapshot);
            const idTokenNonce = requireNonce(provider);
            const { state, codeVerifier } = await generateState(ctx, { idTokenNonce });
            const url = await provider.createAuthorizationURL({
              state,
              codeVerifier,
              idTokenNonce,
              redirectURI: callbackURI,
            });
            return await ctx.json({ url: companyProviderAddress(url.toString()).toString() });
          }),
      ),
      companySignIn: createAuthEndpoint(
        '/company/sign-in',
        {
          method: 'POST',
          body: nativeContract(CompanySignInRequest),
        },
        async (ctx) =>
          await companyAction(async () => {
            const snapshot = await companyConnectionSnapshot(
              dependencies.database,
              dependencies,
              ctx.body.connectionId,
              { slug: ctx.body.workspace },
              true,
            );
            await addOAuthServerContext({ companyIdentity: flowOf(snapshot, 'sign-in') });
            const provider = providerOf(snapshot);
            const idTokenNonce = requireNonce(provider);
            const { state, codeVerifier } = await generateState(ctx, { idTokenNonce });
            const url = await provider.createAuthorizationURL({
              state,
              codeVerifier,
              idTokenNonce,
              redirectURI: callbackURI,
            });
            return await ctx.json({ url: companyProviderAddress(url.toString()).toString() });
          }),
      ),
      companyCallback: createAuthEndpoint(
        '/company/callback',
        {
          method: 'GET',
          requireHeaders: true,
          query: nativeContract(CompanyIdentityCallbackQuery),
        },
        async (ctx) =>
          await companyAction(async () => {
            const state = await parseState(ctx);
            const flow = state.serverContext?.['companyIdentity'];
            if (!Value.Check(CompanyIdentityFlowState, flow) || !state.idTokenNonce)
              throw new APIError('FORBIDDEN', { code: 'COMPANY_IDENTITY_STATE_INVALID' });
            if (ctx.query.error !== undefined || ctx.query.code === undefined)
              throw new APIError('FORBIDDEN', { code: 'COMPANY_IDENTITY_CANCELLED' });
            const snapshot = await companyConnectionSnapshot(
              dependencies.database,
              dependencies,
              flow.connectionId,
              { workspaceId: flow.workspaceId },
              flow.intent !== 'test',
            );
            matchCompanyIdentityFlow(snapshot, flow);
            if (ctx.query.iss !== undefined && ctx.query.iss !== snapshot.credentials.issuer)
              throw new APIError('FORBIDDEN', { code: 'COMPANY_IDENTITY_ISSUER_INVALID' });
            let actor: SessionOwner | undefined;
            if (flow.intent !== 'sign-in') {
              actor = await dependencies.requireActor(ctx.headers);
              if (actor.sessionId !== flow.sessionId || actor.userId !== flow.userId)
                throw identityChanged();
            } else if (flow.userId !== null || flow.sessionId !== null) throw identityChanged();
            const provider = providerOf(snapshot);
            const exchanged = await provider.validateAuthorizationCode({
              code: ctx.query.code,
              codeVerifier: state.codeVerifier,
              redirectURI: callbackURI,
            });
            if (exchanged === null)
              throw identityNotReady('The provider could not complete this sign-in.');
            const verified = await provider.getUserInfo({
              ...exchanged,
              expectedIdTokenNonce: state.idTokenNonce,
            });
            if (verified?.data.iss !== snapshot.credentials.issuer)
              throw identityNotReady('The provider identity could not be verified.');
            const email = verified.user.email;
            if (typeof email !== 'string')
              throw identityNotReady('The provider did not verify an address.');
            const profile = verified.data;
            const authenticatedAt = dependencies.clock.now();
            const result = await runWithTransaction(ctx.context.adapter, async () => {
              const transaction = heldTransaction();
              if (transaction === undefined)
                throw new Error('Company identity requires the native transaction bridge');
              // Resolve the native person only from an exact external binding. A provider address is never consulted.
              let binding =
                flow.intent === 'sign-in'
                  ? await transaction
                      .selectFrom('workspace_identity_bindings')
                      .selectAll()
                      .where('workspace_id', '=', flow.workspaceId)
                      .where('connection_id', '=', flow.connectionId)
                      .where('issuer', '=', profile.iss)
                      .where('subject', '=', profile.sub)
                      .executeTakeFirst()
                  : undefined;
              let context;
              if (flow.intent === 'sign-in') {
                if (snapshot.directoryId !== null) {
                  await transaction
                    .selectFrom('workspaces')
                    .select('id')
                    .where('id', '=', flow.workspaceId)
                    .where('deleted_at', 'is', null)
                    .forUpdate()
                    .executeTakeFirstOrThrow();
                  const directory = await activeDirectoryIdentity(
                    transaction,
                    await getCurrentAdapter(ctx.context.adapter),
                    snapshot,
                    profile,
                    binding?.user_id,
                  );
                  if (directory === null) throw identityChanged();
                  if (binding === undefined) {
                    const initial = await transaction
                      .selectFrom('workspace_directory_identity_links')
                      .select(['id', 'origin'])
                      .where('workspace_id', '=', flow.workspaceId)
                      .where('directory_id', '=', snapshot.directoryId)
                      .where('user_id', '=', directory.userId)
                      .executeTakeFirst();
                    if (initial?.origin !== 'directory_created') throw identityChanged();
                    const consumed = await transaction
                      .selectFrom('workspace_directory_native_initializations')
                      .select('link_reference')
                      .where('link_reference', '=', initial.id)
                      .executeTakeFirst();
                    if (consumed !== undefined) throw identityChanged();
                    binding = await transaction
                      .insertInto('workspace_identity_bindings')
                      .values({
                        workspace_id: flow.workspaceId,
                        connection_id: flow.connectionId,
                        user_id: directory.userId,
                        issuer: profile.iss,
                        subject: profile.sub,
                        created_at: dependencies.clock.now(),
                      })
                      .returningAll()
                      .executeTakeFirstOrThrow();
                    await transaction
                      .insertInto('workspace_directory_native_initializations')
                      .values({
                        link_reference: initial.id,
                        binding_reference: binding.id,
                        created_at: dependencies.clock.now(),
                      })
                      .execute();
                    await ctx.context.internalAdapter.createAccount({
                      userId: directory.userId,
                      providerId: companyProviderId(flow.connectionId),
                      accountId: binding.id,
                    });
                  }
                }
                if (binding === undefined)
                  throw identityNotReady(
                    'Link this company identity from your signed-in account first.',
                  );
                context = await lockCompanySignInMember(
                  transaction,
                  flow.workspaceId,
                  binding.user_id,
                );
              } else {
                if (actor === undefined) throw identityChanged();
                const admitted = await requireWorkspaceMembership(
                  transaction,
                  actor.userId,
                  flow.workspaceId,
                );
                context = await lockCompanyIdentityActor(
                  transaction,
                  dependencies,
                  { context: admitted, sessionId: actor.sessionId },
                  flow.intent === 'test',
                );
              }
              const current = await companyConnectionSnapshot(
                transaction,
                dependencies,
                flow.connectionId,
                { workspaceId: flow.workspaceId },
                flow.intent !== 'test',
              );
              matchCompanyIdentityFlow(current, flow);
              if (flow.intent === 'test') {
                await transaction
                  .updateTable('workspace_identity_connections')
                  .set({
                    tested_authentication_revision: current.authenticationRevision,
                    tested_at: dependencies.clock.now(),
                    revision: crypto.randomUUID(),
                    updated_at: dependencies.clock.now(),
                  })
                  .where('workspace_id', '=', context.workspaceId)
                  .where('id', '=', current.id)
                  .execute();
                await recordAudit(transaction, dependencies.clock, {
                  workspaceId: context.workspaceId,
                  actorUserId: context.userId,
                  action: 'identity.connection_tested',
                  targetType: 'integration',
                  targetId: current.id,
                });
                return null;
              }
              if (flow.intent === 'link') {
                const existing = await transaction
                  .selectFrom('workspace_identity_bindings')
                  .selectAll()
                  .where('workspace_id', '=', context.workspaceId)
                  .where('connection_id', '=', current.id)
                  .where((expression) =>
                    expression.or([
                      expression('user_id', '=', context.userId),
                      expression.and([
                        expression('issuer', '=', profile.iss),
                        expression('subject', '=', profile.sub),
                      ]),
                    ]),
                  )
                  .execute();
                if (
                  existing.some(
                    (row) =>
                      row.user_id !== context.userId ||
                      row.issuer !== profile.iss ||
                      row.subject !== profile.sub,
                  )
                )
                  throw identityNotReady(
                    'This company identity is already linked. Unlink the previous identity before replacing it.',
                  );
                let owned = existing[0];
                owned ??= await transaction
                  .insertInto('workspace_identity_bindings')
                  .values({
                    workspace_id: context.workspaceId,
                    connection_id: current.id,
                    user_id: context.userId,
                    issuer: profile.iss,
                    subject: profile.sub,
                    created_at: dependencies.clock.now(),
                  })
                  .returningAll()
                  .executeTakeFirstOrThrow();
                await consentDirectoryIdentity(
                  transaction,
                  current,
                  profile,
                  context.userId,
                  owned.id,
                  dependencies.clock.now(),
                );
                const account = await transaction
                  .selectFrom('accounts')
                  .select('id')
                  .where('user_id', '=', context.userId)
                  .where('provider_id', '=', companyProviderId(current.id))
                  .where('account_id', '=', owned.id)
                  .executeTakeFirst();
                if (account === undefined)
                  await ctx.context.internalAdapter.createAccount({
                    userId: context.userId,
                    providerId: companyProviderId(current.id),
                    accountId: owned.id,
                  });
                if (existing.length === 0)
                  await recordAudit(transaction, dependencies.clock, {
                    workspaceId: context.workspaceId,
                    actorUserId: context.userId,
                    action: 'identity.linked',
                    targetType: 'integration',
                    targetId: current.id,
                  });
                return null;
              }
              // Membership removal/unlink may have committed while the workspace lock was being acquired.
              const live = await transaction
                .selectFrom('workspace_identity_bindings')
                .select('id')
                .where('workspace_id', '=', context.workspaceId)
                .where('connection_id', '=', current.id)
                .where('user_id', '=', context.userId)
                .where('issuer', '=', profile.iss)
                .where('subject', '=', profile.sub)
                .executeTakeFirst();
              if (binding === undefined || live?.id !== binding.id) throw identityChanged();
              const directory = await activeDirectoryIdentity(
                transaction,
                await getCurrentAdapter(ctx.context.adapter),
                current,
                profile,
                context.userId,
              );
              const finalized = await handleOAuthUserInfo(ctx, {
                userInfo: {
                  ...verified.user,
                  email,
                  name: verified.user.name ?? '',
                  id: binding.id,
                },
                account: { providerId: companyProviderId(current.id), accountId: binding.id },
                disableSignUp: true,
                selectedUser: { userId: context.userId, profile: 'preserve' },
                trustProviderByName: false,
                requireExactAccountBinding: true,
                deferNonDatabaseWrites: true,
              });
              if (finalized.error !== null)
                throw identityNotReady('The existing company identity could not start a session.');
              await transaction
                .updateTable('sessions')
                .set({
                  company_workspace_id: context.workspaceId,
                  directory_id: directory?.proof.directory_id ?? null,
                })
                .where('id', '=', finalized.data.session.id)
                .where('user_id', '=', context.userId)
                .executeTakeFirstOrThrow();
              await transaction
                .insertInto('workspace_identity_sessions')
                .values({
                  ...(directory?.proof ?? {}),
                  session_id: finalized.data.session.id,
                  workspace_id: context.workspaceId,
                  connection_id: current.id,
                  binding_reference: binding.id,
                  authentication_revision: current.authenticationRevision,
                  authenticated_at: authenticatedAt,
                })
                .execute();
              await recordPrimaryAuthentication(
                transaction,
                finalized.data.session.id,
                context.userId,
                {
                  method: 'company_oidc',
                  authenticatedAt,
                  companyWorkspaceId: context.workspaceId,
                  companyConnectionId: current.id,
                  companyAuthenticationRevision: current.authenticationRevision,
                },
              );
              await transaction
                .updateTable('workspace_identity_bindings')
                .set({ last_authenticated_at: dependencies.clock.now() })
                .where('workspace_id', '=', context.workspaceId)
                .where('id', '=', binding.id)
                .execute();
              return finalized.data;
            });
            if (result !== null) await setSessionCookie(ctx, result);
            const location = new URL(
              `/w/${snapshot.slug}${flow.intent === 'test' ? '/settings/company' : flow.intent === 'link' ? '/settings/account' : ''}`,
              dependencies.baseUrl,
            );
            if (flow.intent !== 'sign-in')
              location.searchParams.set('identity', flow.intent === 'test' ? 'tested' : 'linked');
            throw ctx.redirect(location.toString());
          }),
      ),
    },
  };
};
