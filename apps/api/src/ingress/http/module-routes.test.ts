/**
 * What a module's routes are handed (D-250 rule 10): picked field by field, never spread from the application's
 * dependencies, and narrower than what it comes from. The type half is `@ts-expect-error` lines, which fail the build
 * when the error they name stops happening; the run half is the object `createApp` really builds.
 */
import { describe, expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import { compose, type BundledModule } from '../../composition';
import { issuesModule } from '../../features/issues/module';
import type { IssuesDb } from '../../features/issues/schema';
import type { Auth } from '../../modules/auth/better-auth';
import { sessionAuthOf } from '../../modules/auth/sessions';
import { testDependencies } from '../../testing/doubles';
import { createApp } from './app';
import type { ModuleRouteDependencies } from './module-routes';
import { requireSession } from './session';

/** Never called: the compiler is what runs it. Each line is what the red-team review did with the full context. */
export const compileTimeAssertions = (context: ModuleRouteDependencies<IssuesDb>): void => {
  // @ts-expect-error the encryption key is not a setting a module is handed (session forgery needs it)
  String(context.config.ENCRYPTION_KEY);
  // @ts-expect-error nor the database address
  String(context.config.DATABASE_URL);
  // @ts-expect-error the Better Auth instance is behind a handle that only the session readers open
  String(context.auth.api);
  // @ts-expect-error a module's database holds its own tables: another tenant's channels are not among them
  context.database.selectFrom('channels');
  // @ts-expect-error the pool is not handed on
  String(context.pool);
};

describe('the handle a module holds in place of the Better Auth instance', () => {
  test('is refused when it is a copy that sessionAuthOf did not make, which would otherwise be read as the instance', async () => {
    const real = sessionAuthOf({ signInLinks: undefined } as unknown as Auth);
    const request = new Request('https://purlay.test/api/me');
    let refusal: unknown;
    try {
      await requireSession({ ...real }, request);
    } catch (error) {
      refusal = error;
    }
    expect(String(refusal)).toContain('did not make');
  });
});

describe('the context createApp builds for a module', () => {
  test('holds the fields the type names and nothing the application also has', () => {
    let seen: ModuleRouteDependencies<unknown> | undefined;
    const spy: BundledModule = {
      ...issuesModule,
      routes: (context) => {
        seen = context;
        return new Elysia();
      },
    };
    const dependencies = testDependencies();
    createApp({ ...dependencies, composition: compose([spy], [spy], 'open', []) });
    if (seen === undefined) throw new Error('the module was not handed a context');
    expect(Object.keys(seen).sort()).toEqual([
      'atomically',
      'auth',
      'bus',
      'cipher',
      'clock',
      'config',
      'database',
      'githubApi',
      'githubAppApi',
      'githubAppSettings',
      'githubUrls',
      'inbox',
      'limiterFor',
      'log',
      'online',
      'permissions',
      'ports',
      'publishFact',
    ]);
    expect(Object.keys(seen.config).sort()).toEqual(['APP_URL', 'GITHUB_API_URL', 'TRUST_PROXY']);
    expect(seen.auth).not.toBe(dependencies.auth);
    expect('api' in seen.auth).toBe(false);
  });
});
