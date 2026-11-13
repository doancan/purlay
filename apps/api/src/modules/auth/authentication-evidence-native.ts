/** Capture evidence at genuine native authentication boundaries, including retained-session MFA. */
import { symmetricDecrypt } from 'better-auth/crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { betterAuth } from 'better-auth';
import {
  getCurrentAdapter,
  getCurrentDBAdapterAsyncLocalStorage,
  runWithTransaction,
  runWithAdapter,
  tryGetCurrentAuthEndpointContext,
} from '@better-auth/core/context';
import { base32 } from '@better-auth/utils/base32';
import { isTransaction, type Executor } from '@purlay/db';
import type { SessionAuthenticationMethod } from '@purlay/types/workspace-security';
import type { Clock } from '../../platform/clock';
import { heldTransaction } from './sign-up-transaction';
import { SESSION_CLOCK } from './sessions';
import { matchingWorkspaceTotpCounter } from './workspace-totp';
import {
  consumeSecondFactorPrimary,
  recordPrimaryAuthentication,
  rememberSecondFactorPrimary,
  retainUnknownAuthentication,
  type PrimaryAuthenticationProof,
} from './authentication-evidence';

const PASSWORD = '/sign-in/email';
const TOTP = '/two-factor/verify-totp';
const RECOVERY = '/two-factor/verify-backup-code';
const nativeMfaPath = (path: string): boolean => path === TOTP || path === RECOVERY;

interface PrimaryCapture {
  readonly userId: string;
  readonly proof: PrimaryAuthenticationProof;
}

interface MfaCapture {
  readonly userId: string;
  readonly retainedSessionId: string | undefined;
  readonly factorId: string;
  readonly secret: string;
  readonly method: 'totp' | 'recovery';
  readonly counter: number | null;
}

/** Stored only in the native request's existing AsyncLocalStorage round. */
export interface NativeAuthenticationRound {
  primaryAuthentication?: PrimaryCapture | undefined;
  authenticationChallenge?: string | undefined;
  nativeMfa?: MfaCapture | undefined;
}

interface NativeEvidenceDependencies {
  readonly database: Executor;
  readonly clock: Clock;
  readonly instance: ReturnType<typeof betterAuth>;
  readonly round: () => NativeAuthenticationRound | undefined;
  readonly verifiedMethod: (
    path: string,
  ) => Exclude<SessionAuthenticationMethod, 'company_oidc' | 'password'> | undefined;
}

interface NativeEvidenceCapture {
  readonly around: (path: string, body: () => Promise<Response>) => Promise<Response>;
  readonly executor: () => Executor | undefined;
  readonly afterTransaction: (work: () => Promise<void>) => Promise<void>;
  readonly challenge: (
    path: string | undefined,
    value: { readonly identifier: string; readonly value: string; readonly expiresAt: Date },
  ) => Promise<void>;
  readonly prepareMfa: (
    path: string,
    headers: Headers | undefined,
    body: unknown,
    readChallenge: () => Promise<string | null | false>,
  ) => Promise<void>;
  readonly after: (
    path: string,
    failed: boolean,
    madeSessionId: string | undefined,
  ) => Promise<void>;
}

interface NativeAdapterFrame {
  adapter: Awaited<ReturnType<typeof getCurrentAdapter>>;
  pendingHooks: (() => Promise<void>)[];
  isTransactionActive: boolean;
}

/** This records a cryptographic fact, not admission; canonical content guards still decide access. */
const lockIndependentEvidenceSession = async (
  executor: Executor,
  sessionId: string,
  userId: string,
): Promise<boolean> => {
  const source = await executor
    .selectFrom('sessions')
    .select('company_workspace_id')
    .where('id', '=', sessionId)
    .where('user_id', '=', userId)
    .where('expires_at', '>', SESSION_CLOCK.now())
    .forShare()
    .executeTakeFirst();
  return source?.company_workspace_id === null;
};

export const nativeAuthenticationEvidence = (
  dependencies: NativeEvidenceDependencies,
): NativeEvidenceCapture => {
  const { instance, database, clock } = dependencies;
  interface ActiveNativeTransaction {
    readonly executor: Executor;
    readonly adapter: Awaited<ReturnType<typeof getCurrentAdapter>>;
    readonly pendingHooks: (() => Promise<void>)[];
    readonly frames: Map<NativeAdapterFrame, NativeAdapterFrame>;
    active: boolean;
  }
  interface NativeRequestTransaction {
    current: ActiveNativeTransaction | undefined;
    readonly begin: () => Promise<void>;
    readonly after: (() => Promise<void>)[];
    closed: boolean;
  }
  const nativeTransaction = new AsyncLocalStorage<NativeRequestTransaction>();
  /** The request may begin before admission, but only the exact live SQL callback supplies an executor. */
  const evidenceTransaction = (database: Executor): Executor | undefined => {
    const current = nativeTransaction.getStore()?.current;
    return (
      heldTransaction() ??
      (current?.active === true ? current.executor : isTransaction(database) ? database : undefined)
    );
  };
  // Install after native plugin initialization, which recreates the adapter at the end of init.
  const ready = instance.$context.then((context) => {
    // Native twoFactor writes directly through context.adapter. The handler also opens a fresh
    // native async frame, so retain the selected adapter only for our exact active SQL callback.
    const ordinary = context.adapter;
    context.adapter = new Proxy(ordinary, {
      get: (target, property): unknown => {
        const value: unknown = Reflect.get(target, property, target);
        if (typeof value !== 'function') return value;
        return async (...args: unknown[]): Promise<unknown> => {
          const request = nativeTransaction.getStore();
          const held = request?.current;
          const exact =
            held?.active === true && evidenceTransaction(database) === held.executor
              ? held
              : undefined;
          if (property === 'transaction') {
            if (exact !== undefined && typeof args[0] === 'function')
              return await Reflect.apply(args[0], undefined, [exact.adapter]);
            return await Reflect.apply(value, target, args);
          }
          const selected =
            exact?.adapter ??
            (request === undefined ? await getCurrentAdapter(ordinary) : ordinary);
          const current = selected === context.adapter ? ordinary : selected;
          const operation: unknown = Reflect.get(current, property, current);
          if (typeof operation !== 'function') throw new Error('Native adapter operation was lost');
          return await Reflect.apply(operation, current, args);
        };
      },
    });
    const create = context.internalAdapter.createSession.bind(context.internalAdapter);
    context.internalAdapter.createSession = async (
      ...args: Parameters<typeof create>
    ): ReturnType<typeof create> => {
      const round = dependencies.round();
      const path = tryGetCurrentAuthEndpointContext()?.path ?? '';
      if (round !== undefined && path === PASSWORD)
        round.primaryAuthentication = {
          userId: args[0],
          proof: { method: 'password', authenticatedAt: clock.now() },
        };
      return await runWithTransaction(context.adapter, async () => {
        const session = await create(...args);
        if (round === undefined) return session;
        const executor = evidenceTransaction(database);
        if (executor === undefined) throw new Error('Native authentication transaction was lost');
        if (
          nativeMfaPath(path) &&
          round.nativeMfa?.retainedSessionId === undefined &&
          round.authenticationChallenge !== undefined
        ) {
          const primary = await consumeSecondFactorPrimary(
            executor,
            round.authenticationChallenge,
            args[0],
            SESSION_CLOCK.now(),
          );
          if (primary !== undefined)
            await recordPrimaryAuthentication(executor, session.id, args[0], primary);
        } else {
          const method = dependencies.verifiedMethod(path);
          if (method !== undefined)
            await recordPrimaryAuthentication(executor, session.id, args[0], {
              method,
              authenticatedAt: clock.now(),
            });
        }
        return session;
      });
    };
    return context;
  });

  const around = async (path: string, body: () => Promise<Response>): Promise<Response> => {
    const context = await ready;
    if (path !== PASSWORD && !nativeMfaPath(path)) return await body();
    const failure = new Error('Native authentication failed before commit');
    const admitted = Promise.withResolvers<undefined>();
    const completed = Promise.withResolvers<{
      readonly commit: boolean;
      readonly error: unknown;
    }>();
    let transaction:
      Promise<{ readonly ok: true } | { readonly ok: false; readonly error: unknown }> | undefined;
    const request: NativeRequestTransaction = {
      current: undefined,
      closed: false,
      after: [],
      begin: async (): Promise<void> => {
        transaction ??= runWithTransaction(context.adapter, async () => {
          const executor = evidenceTransaction(database);
          if (executor === undefined) throw new Error('Native authentication transaction was lost');
          const adapter = await getCurrentAdapter(context.adapter);
          const outer = (await getCurrentDBAdapterAsyncLocalStorage()).getStore();
          if (outer === undefined) throw new Error('Native authentication context was lost');
          const marker: ActiveNativeTransaction = {
            executor,
            adapter,
            pendingHooks: outer.pendingHooks,
            frames: new Map<NativeAdapterFrame, NativeAdapterFrame>(),
            active: true,
          };
          request.current = marker;
          admitted.resolve(undefined);
          try {
            const outcome = await completed.promise;
            if (!outcome.commit) throw outcome.error;
          } finally {
            marker.active = false;
            for (const [frame, original] of marker.frames) Object.assign(frame, original);
          }
        }).then(
          () => ({ ok: true as const }),
          (error: unknown) => {
            admitted.reject(error);
            return { ok: false as const, error };
          },
        );
        await admitted.promise;
      },
    };
    return await nativeTransaction.run(request, async () => {
      let response: Response | undefined;
      let failed = false;
      let bodyError: unknown;
      try {
        response = await runWithAdapter(context.adapter, body);
      } catch (error) {
        failed = true;
        bodyError = error;
      }
      completed.resolve({
        commit: !failed && response !== undefined && response.status < 500,
        error: failed ? bodyError : failure,
      });
      const settled = await transaction;
      request.closed = true;
      for (const after of request.after) await after();
      if (failed) throw bodyError;
      if (settled?.ok === false && settled.error !== failure) throw settled.error;
      if (response === undefined) throw new Error('Native authentication response was lost');
      return response;
    });
  };

  return {
    around,
    executor: () => evidenceTransaction(database),
    afterTransaction: async (work): Promise<void> => {
      const request = nativeTransaction.getStore();
      if (request !== undefined && !request.closed) {
        request.after.push(work);
        return;
      }
      await work();
    },
    challenge: async (path, value): Promise<void> => {
      const primary = dependencies.round()?.primaryAuthentication;
      if (
        path !== PASSWORD ||
        primary?.proof.method !== 'password' ||
        value.value !== primary.userId ||
        !/^2fa-[A-Za-z0-9_-]{20}$/u.test(value.identifier)
      )
        return;
      const executor = evidenceTransaction(database);
      if (executor === undefined) throw new Error('Native challenge transaction was lost');
      await rememberSecondFactorPrimary(
        executor,
        value.identifier,
        primary.userId,
        primary.proof.authenticatedAt,
        value.expiresAt,
      );
    },
    prepareMfa: async (path, headers, body, readChallenge): Promise<void> => {
      // runWithAdapter in the native handler/API resets its async transaction frame. Rebind
      // that frame to the original native transaction, including its after-commit hook queue.
      // Restoring each frame prevents delayed child work from retaining completed authority.
      const request = nativeTransaction.getStore();
      if (request !== undefined && !request.closed) await request.begin();
      const held = request?.current;
      if (held?.active === true && evidenceTransaction(database) === held.executor) {
        const frame = (await getCurrentDBAdapterAsyncLocalStorage()).getStore();
        if (frame !== undefined && !held.frames.has(frame)) {
          held.frames.set(frame, { ...frame });
          frame.adapter = held.adapter;
          frame.pendingHooks = held.pendingHooks;
          frame.isTransactionActive = true;
        }
      }
      const round = dependencies.round();
      if (!nativeMfaPath(path) || round === undefined) return;
      const executor = evidenceTransaction(database);
      if (executor === undefined) return;
      const context = await ready;
      const found = await instance.api.getSession({
        headers: headers ?? new Headers(),
        query: { disableRefresh: true },
      });
      let userId = found?.user.id;
      const retainedSessionId = found?.session.id;
      if (found !== null) {
        if (!(await lockIndependentEvidenceSession(executor, found.session.id, found.user.id)))
          return;
      } else {
        const identifier = await readChallenge();
        if (typeof identifier !== 'string') return;
        const challenge = await executor
          .selectFrom('verifications')
          .select('value')
          .where('identifier', '=', identifier)
          .where('expires_at', '>', SESSION_CLOCK.now())
          .executeTakeFirst();
        if (challenge === undefined) return;
        round.authenticationChallenge = identifier;
        userId = challenge.value;
      }
      if (userId === undefined) return;
      const owner = await executor
        .selectFrom('users')
        .select('id')
        .where('id', '=', userId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (owner === undefined) return;
      const factor = await executor
        .selectFrom('two_factors')
        .select(['id', 'secret'])
        .where('user_id', '=', userId)
        .forUpdate()
        .executeTakeFirst();
      if (factor === undefined) return;
      let counter: number | null = null;
      if (
        path === TOTP &&
        typeof body === 'object' &&
        body !== null &&
        'code' in body &&
        typeof body.code === 'string'
      ) {
        const clear = await symmetricDecrypt({ key: context.secretConfig, data: factor.secret });
        const secret = clear.startsWith('base32:')
          ? base32.decode(clear.slice(7).toUpperCase())
          : new TextEncoder().encode(clear);
        counter = await matchingWorkspaceTotpCounter(secret, body.code, SESSION_CLOCK.now());
      }
      round.nativeMfa = {
        userId,
        retainedSessionId,
        factorId: factor.id,
        secret: factor.secret,
        method: path === TOTP ? 'totp' : 'recovery',
        counter,
      };
    },
    after: async (path, failed, madeSessionId): Promise<void> => {
      const round = dependencies.round();
      if (failed || round === undefined) return;
      const executor = evidenceTransaction(database);
      if (
        path === PASSWORD &&
        madeSessionId !== undefined &&
        round.primaryAuthentication !== undefined
      ) {
        if (executor === undefined) throw new Error('Primary authentication transaction was lost');
        await recordPrimaryAuthentication(
          executor,
          madeSessionId,
          round.primaryAuthentication.userId,
          round.primaryAuthentication.proof,
        );
      }
      const mfa = round.nativeMfa;
      if (!nativeMfaPath(path) || mfa === undefined || executor === undefined) return;
      const sessionId = mfa.retainedSessionId ?? madeSessionId;
      if (sessionId === undefined) return;
      if (!(await lockIndependentEvidenceSession(executor, sessionId, mfa.userId))) return;
      const factor = await executor
        .selectFrom('two_factors')
        .select(['id', 'secret', 'verified', 'assurance_revision', 'last_assurance_counter'])
        .where('id', '=', mfa.factorId)
        .where('user_id', '=', mfa.userId)
        .forUpdate()
        .executeTakeFirst();
      if (factor?.verified !== true || factor.secret !== mfa.secret) return;
      if (mfa.method === 'totp') {
        if (
          mfa.counter === null ||
          (factor.last_assurance_counter !== null &&
            BigInt(factor.last_assurance_counter) >= BigInt(mfa.counter))
        )
          return;
        await executor
          .updateTable('two_factors')
          .set({ last_assurance_counter: mfa.counter })
          .where('id', '=', factor.id)
          .execute();
      }
      await retainUnknownAuthentication(executor, sessionId, mfa.userId);
      const verifiedAt = clock.now();
      await executor
        .updateTable('session_authentication_evidence')
        .set({
          global_mfa_factor_id: factor.id,
          global_mfa_factor_revision: factor.assurance_revision,
          global_mfa_method: mfa.method,
          global_mfa_counter: mfa.counter,
          global_mfa_verified_at: verifiedAt,
          updated_at: verifiedAt,
        })
        .where('session_id', '=', sessionId)
        .where('user_id', '=', mfa.userId)
        .execute();
    },
  };
};
