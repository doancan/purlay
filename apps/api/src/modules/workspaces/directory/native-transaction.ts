/** Exact request-owned native transaction, with attempt savepoints and revocable callback scopes. */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { betterAuth } from 'better-auth';
import {
  getCurrentAdapter,
  getCurrentDBAdapterAsyncLocalStorage,
  runWithTransaction,
} from '@better-auth/core/context';
import type { DBTransactionAdapter } from '@better-auth/core/db/adapter';
import { isTransaction, sql, type Executor, type Transaction } from '@purlay/db';
import { heldTransaction } from '../../auth/sign-up-transaction';
import type { WorkspaceProjectionScope } from '../provisioning/scope';
import type { VerifiedDirectoryCredential } from './credentials';

type NativeAuth = ReturnType<typeof betterAuth>;
type NativeContext = Awaited<NativeAuth['$context']>;
interface AdapterFrame {
  adapter: Awaited<ReturnType<typeof getCurrentAdapter>>;
  pendingHooks: (() => Promise<void>)[];
  isTransactionActive: boolean;
}
interface ParentTicket {
  readonly owner: Operation;
  readonly auth: NativeContext;
  readonly transaction: Transaction;
  readonly adapter: DBTransactionAdapter;
  readonly userId: string;
  readonly operation: symbol;
  consumed: boolean;
}
export interface ActiveDirectoryTransaction {
  readonly transaction: Transaction;
  readonly adapter: DBTransactionAdapter;
  readonly scope: WorkspaceProjectionScope;
  readonly credential: VerifiedDirectoryCredential;
}
interface Operation {
  readonly id: symbol;
  readonly owner: symbol;
  readonly auth: NativeContext;
  readonly request: Request;
  readonly admitted: ReturnType<typeof Promise.withResolvers<undefined>>;
  readonly completed: ReturnType<typeof Promise.withResolvers<boolean>>;
  readonly frames: Map<AdapterFrame, AdapterFrame>;
  active: boolean;
  callbackOnly: boolean;
  callbackActive: boolean;
  current: ActiveDirectoryTransaction | undefined;
  hooks: (() => Promise<void>)[];
  ticket: ParentTicket | undefined;
  admission: { readonly email: string; consumed: boolean } | undefined;
  running:
    Promise<{ readonly ok: true } | { readonly ok: false; readonly error: unknown }> | undefined;
}
const operations = new AsyncLocalStorage<Operation>();
const lost = (): Error => new Error('Directory native transaction authority is not current.');
export interface NativeDirectoryTransactions {
  readonly initialize: (instance: NativeAuth, after: Promise<unknown>) => void;
  readonly around: (request: Request, body: () => Promise<Response>) => Promise<Response>;
  readonly begin: (credential: VerifiedDirectoryCredential) => Promise<ActiveDirectoryTransaction>;
  readonly executor: () => Transaction | undefined;
  readonly current: (adapter?: DBTransactionAdapter) => ActiveDirectoryTransaction;
  readonly child: <T>(
    adapter: DBTransactionAdapter,
    body: (current: ActiveDirectoryTransaction) => Promise<T>,
  ) => Promise<T>;
  readonly expectInactiveDelete: (adapter: DBTransactionAdapter, userId: string) => void;
  readonly initializeUser: <T>(email: string, body: () => Promise<T>) => Promise<T>;
  readonly consumeAdmission: (email: string) => Promise<boolean>;
  readonly denyGlobalProfileWrite: () => void;
  readonly afterCommit: (effect: () => Promise<void>) => void;
}
export const nativeDirectoryTransactions = (
  database: Executor,
  prepare: (current: ActiveDirectoryTransaction, request: Request) => Promise<void>,
  prelock: (
    transaction: Transaction,
    credential: VerifiedDirectoryCredential,
  ) => Promise<{
    readonly scope: WorkspaceProjectionScope;
    readonly credential: VerifiedDirectoryCredential;
  }>,
  finish: (
    current: ActiveDirectoryTransaction,
    request: Request,
    response: Response,
  ) => Promise<void>,
  failure: (error: unknown) => Response,
): NativeDirectoryTransactions => {
  const owner = Symbol('DirectoryAuthOwner');
  let ready: Promise<NativeContext> | undefined;
  const active = (adapter?: DBTransactionAdapter): Operation => {
    const operation = operations.getStore();
    if (
      operation?.owner !== owner ||
      !operation.active ||
      !operation.callbackActive ||
      operation.current === undefined ||
      (adapter !== undefined && operation.current.adapter !== adapter)
    )
      throw lost();
    const held = heldTransaction();
    if (held !== undefined && held !== operation.current.transaction) throw lost();
    return operation;
  };
  const current = (adapter?: DBTransactionAdapter): ActiveDirectoryTransaction => {
    const value = active(adapter).current;
    if (value === undefined) throw lost();
    return value;
  };
  const initialize = (instance: NativeAuth, after: Promise<unknown>): void => {
    if (ready !== undefined) throw new Error('Directory native composition was initialized twice.');
    ready = after
      .then(async () => await instance.$context)
      .then((context) => {
        const ordinary = context.adapter;
        context.adapter = new Proxy(ordinary, {
          get: (target, property): unknown => {
            if (property !== 'transaction') {
              const value: unknown = Reflect.get(target, property, target);
              return typeof value === 'function' ? value.bind(target) : value;
            }
            return async <Result>(
              callback: (adapter: DBTransactionAdapter) => Promise<Result>,
            ): Promise<Result> => {
              const operation = operations.getStore();
              if (
                operation?.owner !== owner ||
                !operation.active ||
                !operation.callbackActive ||
                operation.current === undefined
              )
                return await target.transaction(callback);
              const checkpoint = operation.hooks.length;
              await sql`savepoint directory_scim_attempt`.execute(operation.current.transaction);
              try {
                const result = await callback(operation.current.adapter);
                await sql`release savepoint directory_scim_attempt`.execute(
                  operation.current.transaction,
                );
                return result;
              } catch (error) {
                await sql`rollback to savepoint directory_scim_attempt`.execute(
                  operation.current.transaction,
                );
                await sql`release savepoint directory_scim_attempt`.execute(
                  operation.current.transaction,
                );
                operation.hooks.splice(checkpoint);
                operation.ticket = undefined;
                throw error;
              }
            };
          },
        });
        const original = context.internalAdapter.deleteUserSessions.bind(context.internalAdapter);
        context.internalAdapter.deleteUserSessions = async (
          ...args: Parameters<typeof original>
        ): ReturnType<typeof original> => {
          const operation = operations.getStore();
          if (operation === undefined) {
            await original(...args);
            return;
          }
          const ticket = operation.ticket;
          const selected = await getCurrentAdapter(context.adapter);
          if (
            operation.owner !== owner ||
            !operation.active ||
            operation.callbackOnly ||
            !operation.callbackActive ||
            operation.current === undefined ||
            ticket?.owner !== operation ||
            ticket.auth !== context ||
            ticket.transaction !== operation.current.transaction ||
            ticket.adapter !== operation.current.adapter ||
            selected !== operation.current.adapter ||
            ticket.userId !== args[0] ||
            ticket.operation !== operation.id ||
            ticket.consumed
          )
            throw lost();
          ticket.consumed = true;
        };
        return context;
      });
  };
  const begin = async (
    credential: VerifiedDirectoryCredential,
  ): Promise<ActiveDirectoryTransaction> => {
    const operation = operations.getStore();
    if (operation?.owner !== owner || !operation.active || operation.callbackOnly) throw lost();
    operation.running ??= runWithTransaction(operation.auth.adapter, async () => {
      const transaction = heldTransaction() ?? (isTransaction(database) ? database : undefined);
      if (transaction === undefined) throw lost();
      operation.callbackActive = true;
      const adapter = await getCurrentAdapter(operation.auth.adapter);
      const frame = (await getCurrentDBAdapterAsyncLocalStorage()).getStore();
      if (frame === undefined) throw lost();
      operation.hooks = frame.pendingHooks;
      try {
        const locked = await prelock(transaction, credential);
        operation.current = {
          transaction,
          adapter,
          scope: locked.scope,
          credential: locked.credential,
        };
        await prepare(operation.current, operation.request);
        operation.admitted.resolve(undefined);
        if (!(await operation.completed.promise)) throw lost();
      } finally {
        operation.callbackActive = false;
        operation.admission = undefined;
        operation.ticket = undefined;
      }
    }).then(
      () => ({ ok: true as const }),
      (error: unknown) => {
        operation.callbackActive = false;
        operation.admitted.reject(error);
        return { ok: false as const, error };
      },
    );
    await operation.admitted.promise;
    const frame = (await getCurrentDBAdapterAsyncLocalStorage()).getStore();
    if (frame === undefined) throw lost();
    if (!operation.frames.has(frame)) operation.frames.set(frame, { ...frame });
    const selected = current();
    frame.adapter = selected.adapter;
    frame.pendingHooks = operation.hooks;
    frame.isTransactionActive = false;
    return selected;
  };
  return {
    initialize,
    begin,
    current,
    around: async (request, body): Promise<Response> => {
      if (!new URL(request.url).pathname.startsWith('/auth/scim/v2/')) return await body();
      const context = await ready;
      if (context === undefined) throw lost();
      const operation: Operation = {
        id: Symbol('DirectoryRequest'),
        owner,
        auth: context,
        request,
        admitted: Promise.withResolvers<undefined>(),
        completed: Promise.withResolvers<boolean>(),
        frames: new Map(),
        active: true,
        callbackOnly: false,
        callbackActive: false,
        current: undefined,
        hooks: [],
        ticket: undefined,
        admission: undefined,
        running: undefined,
      };
      return await operations.run(operation, async () => {
        let response: Response | undefined;
        try {
          response = await body();
          if (response.status < 400 && operation.current !== undefined)
            await finish(operation.current, request, response);
        } catch (cause) {
          response = failure(cause);
        }
        operation.completed.resolve(response.status < 400);
        const settled = await operation.running;
        operation.active = false;
        for (const [frame, original] of operation.frames) Object.assign(frame, original);
        if (settled?.ok === false && response.status < 400) return failure(settled.error);
        return response;
      });
    },
    executor: (): Transaction | undefined => {
      const operation = operations.getStore();
      return operation?.owner === owner && operation.active && operation.callbackActive
        ? operation.current?.transaction
        : undefined;
    },
    child: async <Result>(
      adapter: DBTransactionAdapter,
      body: (current: ActiveDirectoryTransaction) => Promise<Result>,
    ): Promise<Result> => {
      const parent = active(adapter);
      const selected = current(adapter);
      const frame = (await getCurrentDBAdapterAsyncLocalStorage()).getStore();
      if (frame !== undefined && frame.pendingHooks !== parent.hooks) {
        parent.hooks.push(...frame.pendingHooks.splice(0));
        frame.pendingHooks = parent.hooks;
      }
      const child: Operation = {
        ...parent,
        callbackOnly: true,
        ticket: undefined,
        admission: undefined,
      };
      try {
        return await operations.run(child, async () => await body(selected));
      } finally {
        child.active = false;
        child.callbackActive = false;
      }
    },
    expectInactiveDelete: (adapter, userId): void => {
      const parent = active(adapter);
      if (parent.callbackOnly || parent.ticket?.consumed === false) throw lost();
      const selected = current(adapter);
      parent.ticket = {
        owner: parent,
        auth: parent.auth,
        transaction: selected.transaction,
        adapter: selected.adapter,
        userId,
        operation: parent.id,
        consumed: false,
      };
    },
    initializeUser: async <Result>(email: string, body: () => Promise<Result>): Promise<Result> => {
      const parent = active();
      if (parent.callbackOnly || parent.admission !== undefined) throw lost();
      parent.admission = { email, consumed: false };
      try {
        return await body();
      } finally {
        parent.admission = undefined;
      }
    },
    consumeAdmission: async (email): Promise<boolean> => {
      const operation = operations.getStore();
      if (operation === undefined) return false;
      const parent = active();
      const admission = parent.admission;
      if ((await getCurrentAdapter(parent.auth.adapter)) !== parent.current?.adapter) throw lost();
      if (parent.callbackOnly || admission?.email !== email || admission.consumed) throw lost();
      admission.consumed = true;
      return true;
    },
    afterCommit: (effect): void => {
      const parent = active();
      if (parent.callbackOnly) throw lost();
      parent.hooks.push(effect);
    },
    denyGlobalProfileWrite: (): void => {
      if (operations.getStore() !== undefined)
        throw new Error('A directory cannot change a canonical global profile.');
    },
  };
};
