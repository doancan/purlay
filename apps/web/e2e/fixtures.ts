/**
 * What every browser test starts from: the seeded world, a way to sign in as one of its
 * people, and the three checks the specs keep reaching for — accessibility, keyboard-only
 * movement, and a clock.
 *
 * Nothing here knows what a screen looks like. A spec says what it expects; this says how
 * to be somebody, how to ask axe, and how to measure — so the specs written when the
 * feed, the composer and the palette land are four lines each, not four hundred.
 */
import AxeBuilder from '@axe-core/playwright';
import type { Result } from 'axe-core';
import {
  test as base,
  expect,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
  type TestInfo,
} from '@playwright/test';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  apiAs,
  makeRoom,
  sessionApi,
  type ApiClient,
  type Persona,
  type Room,
  type RoomOptions,
  type Tenant,
} from './support';

export type { Persona, Room };

const run = promisify(execFile);

/**
 * Somebody in no workspace, signed in twice (`demo-seed.ts`): for a test that ends every session a
 * person holds, or makes a workspace of its own to change. A test that ends every session a person
 * holds takes a `newcomer` instead, never a shared outsider: the others' sessions would end with it.
 */
type Outsider = 'erin' | 'frank' | 'gwen';

/** A workspace as `POST /api/workspaces` answers it. */
interface OwnWorkspace {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
}

/** What `scripts/demo.ts` wrote after seeding (`apps/api/src/cli/demo-seed.ts`). */
interface World {
  readonly workspace: { readonly id: string; readonly slug: string; readonly name: string };
  readonly personas: Readonly<
    Record<Persona, { readonly userId: string; readonly username: string; readonly token: string }>
  >;
  readonly channels: Readonly<
    Record<'api' | 'deploys' | 'incidents' | 'design' | 'security' | 'dmAlice' | 'dmSelf', string>
  >;
  readonly outsiders: Readonly<
    Record<
      Outsider,
      {
        readonly userId: string;
        readonly username: string;
        readonly tokens: readonly [string, string];
      }
    >
  >;
  readonly messages: Readonly<Record<string, string>>;
  readonly counts: { readonly messages: number };
  /** The scratch database this world lives in (`scripts/demo.ts`), for `freshSessionOf`. */
  readonly database: string;
}

/**
 * A session the seed did not make, for an outsider (`apps/api/src/cli/demo-session.ts`): signing out
 * everywhere ends every session a person holds, so a test of it would leave the seeded ones dead for
 * its own retry, or a second run against the same server.
 */
/** A session cookie's value as Better Auth signs it (D-179): the token, a dot, its signature, URI-encoded. */
const SIGNED_TOKEN = /^[\w-]{32,}\.[\w%]{40,}$/;

const freshSessionOf = (world: World, outsider: string): string => {
  const printed = execFileSync(
    'bun',
    ['--no-env-file', 'run', 'apps/api/src/cli/demo-session.ts', '--as', outsider],
    {
      cwd: join(import.meta.dirname, '../../..'),
      env: { ...process.env, DATABASE_URL: world.database },
      encoding: 'utf8',
    },
  ).trim();
  // Fail here, saying what came back, rather than as a 401 three steps later.
  if (!SIGNED_TOKEN.test(printed)) {
    throw new Error(
      `demo-session.ts printed something that is not a token: ${printed.slice(0, 80)}`,
    );
  }
  return printed;
};

/**
 * Somebody made for one test alone (`demo-session.ts --new`), signed in once, in no workspace. The
 * write budget is per person (`WRITE_BUDGET`), and the seeded four are every test's at once: a test
 * whose own writes are many — a long history — or whose page is a person the others write as, waits
 * behind them, and under load runs out of time or is refused. A newcomer's budget is the test's.
 */
export interface Newcomer {
  readonly userId: string;
  readonly username: string;
  /** Speaks to the API with their session. */
  readonly api: ApiClient;
  /** Their browser, in this project's colour scheme and window, signed in and closed with the test. */
  readonly page: () => Promise<Page>;
  /** Their browser signed in with a second session of its own: ending one does not end this, signing out everywhere ends both. */
  readonly pageWithAnotherSession: () => Promise<Page>;
}

const madePerson = async (
  world: World,
  username: string,
): Promise<{ userId: string; token: string }> => {
  const printed = (
    await run(
      'bun',
      ['--no-env-file', 'run', 'apps/api/src/cli/demo-session.ts', '--new', username],
      {
        cwd: join(import.meta.dirname, '../../..'),
        env: { ...process.env, DATABASE_URL: world.database },
        encoding: 'utf8',
      },
    )
  ).stdout.trim();
  const [userId, token] = printed.split(' ');
  // Fail here, saying what came back, rather than as a 401 three steps later.
  if (userId === undefined || token === undefined || !SIGNED_TOKEN.test(token)) {
    throw new Error(
      `demo-session.ts --new printed something that is not a person: ${printed.slice(0, 80)}`,
    );
  }
  return { userId, token };
};

/** A workspace the first newcomer makes, every other one invited by a link and joined. */
export const workspaceFor = async (
  owner: Newcomer,
  ...others: readonly Newcomer[]
): Promise<OwnWorkspace> => {
  const slug = `${owner.username}-own`.slice(0, 64);
  const workspace = await owner.api.post<OwnWorkspace>('/api/workspaces', { name: slug, slug });
  for (const other of others) {
    const { token } = await owner.api.post<{ token: string }>(
      `/api/workspaces/${workspace.id}/invitations`,
    );
    await other.api.post('/api/invitations/accept', { token });
  }
  return workspace;
};

const SESSION_COOKIE = '__Host-purlay_session';

/** The page's way to tell the test that the policy refused something. */
const POLICY_REPORT = 'reportPolicyViolation';

/** Sent through the same binding to mark that every report before it has arrived. */
const SETTLED = '[settled]';

declare global {
  interface Window {
    reportPolicyViolation?: (text: string) => Promise<void>;
  }
}

interface Fixtures {
  /**
   * Every answer `429` the server gave to a page of this test, named. The write budget is per
   * person, and a test that is refused its budget fails in some unrelated assertion a few seconds
   * later; this fails it first, saying what happened. (Automatic: every test has it.)
   */
  readonly throttling: { readonly watch: (context: BrowserContext) => void };
  /**
   * Every load or style the document's security policy refused (D-102), named. The policy is
   * the server's, so a refusal is a part of the interface that silently does not work in
   * production; every test fails on one. (Automatic: every test has it.)
   */
  readonly securityPolicy: {
    /** `scripts: false` for a context made with JavaScript off: its pages cannot be asked anything. */
    readonly watch: (context: BrowserContext, options?: { scripts?: boolean }) => Promise<void>;
    /** Waits until every open page of the context has delivered what it reported. */
    readonly settle: (context: BrowserContext) => Promise<void>;
  };
  readonly world: World;
  /** Carries the genuine session cookie of one of the seeded people; returns where it signed in. */
  readonly signIn: (persona?: Persona) => Promise<void>;
  /** Fails with every violation, named, if axe finds any on the page as it is now — the scope’s page, when one is given. */
  readonly expectNoAxe: (scope?: Locator) => Promise<void>;
  /** The workspace as the API clients see it. */
  readonly tenant: Tenant;
  /** Speaks to the API as one of the seeded people, with their genuine session. */
  readonly api: (persona: Persona) => ApiClient;
  /** A channel of the test's own, with its people in it and its history written (`support.ts`). */
  readonly room: (options?: RoomOptions) => Promise<Room>;
  /**
   * Another person's browser, in the same colour scheme and window as this project's, already
   * signed in and closed with the test. The page under test is `page`; this is who it talks to.
   */
  readonly asPerson: (persona: Persona) => Promise<Page>;
  /** An outsider's browser, signed in with the first or the second seeded session, or a fresh one. */
  readonly asOutsider: (outsider: Outsider, session?: 0 | 1 | 'fresh') => Promise<Page>;
  /** A workspace an outsider makes, through the API, with a name of the test's own. */
  readonly workspaceOf: (outsider: Outsider) => Promise<OwnWorkspace>;
  /** Somebody nobody else in the run is, named after what they are for (`Newcomer`). */
  readonly newcomer: (label: string) => Promise<Newcomer>;
}

/**
 * **A scrollable block in a message whose row is out is reached through its row** (D-168): a list of
 * messages is one Tab stop, and a code block, a diff or a table in any other message than the focused
 * one is out of the Tab order until its row is focused — then Tab reaches it. axe audits the page as
 * it stands and cannot see that path, so it calls the block unreachable. Such a finding is not
 * excused here, it is *checked*: the row is focused, and only a block that is then a stop is dropped
 * from the violation; one that is still not a stop — or that is in no row, or in the row focus is
 * already in — stays a violation. Focus goes back where it was.
 */
const withoutRowsOut = async (page: Page, violations: readonly Result[]): Promise<Result[]> => {
  const kept: Result[] = [];
  for (const violation of violations) {
    if (violation.id !== 'scrollable-region-focusable') {
      kept.push(violation);
      continue;
    }
    const nodes = [];
    for (const node of violation.nodes) {
      const [selector, ...deeper] = node.target;
      const throughItsRow =
        typeof selector === 'string' &&
        deeper.length === 0 &&
        (await page.evaluate((target) => {
          const block = document.querySelector<HTMLElement>(target);
          const row = block?.closest<HTMLElement>('[data-message-row]');
          if (block == null || row == null || row.contains(document.activeElement)) return false;
          const before = document.activeElement;
          row.focus({ preventScroll: true });
          const reached =
            block.tabIndex >= 0 &&
            !block.hasAttribute('inert') &&
            block.closest('[inert]') === null;
          if (before instanceof HTMLElement && before !== document.body) {
            before.focus({ preventScroll: true });
          } else {
            row.blur();
          }
          return reached;
        }, selector));
      if (!throughItsRow) nodes.push(node);
    }
    if (nodes.length > 0) kept.push({ ...violation, nodes });
  }
  return kept;
};

export const test = base.extend<Fixtures>({
  throttling: [
    async ({ context }, use): Promise<void> => {
      const refused: string[] = [];
      const watch = (watched: BrowserContext): void => {
        watched.on('response', (response) => {
          if (response.status() === 429) {
            refused.push(`${response.request().method()} ${new URL(response.url()).pathname}`);
          }
        });
      };
      watch(context);
      await use({ watch });
      expect(refused, 'the server refused these for want of write budget (429)').toEqual([]);
    },
    { auto: true },
  ],

  securityPolicy: [
    async ({ context, javaScriptEnabled }, use): Promise<void> => {
      const refused: string[] = [];
      // A page with JavaScript off runs no script and answers no evaluation — not even
      // Playwright's — so it is settled by the console witness alone.
      const scriptless = new WeakSet<BrowserContext>();
      const watch = async (
        watched: BrowserContext,
        options: { scripts?: boolean } = {},
      ): Promise<void> => {
        if (options.scripts === false) scriptless.add(watched);
        await watched.exposeBinding(POLICY_REPORT, (_source, text: string) => {
          if (text !== SETTLED) refused.push(text);
        });
        // A second witness, which needs no script in the page: the browser's own line. A page
        // with JavaScript off is held to the policy too.
        watched.on('console', (message) => {
          if (message.type() === 'error' && message.text().includes('Content Security Policy')) {
            refused.push(message.text());
          }
        });
        // Before any script of the page runs, so a refusal during the first paint is seen.
        await watched.addInitScript(() => {
          document.addEventListener(
            'securitypolicyviolation',
            (event) => {
              void window.reportPolicyViolation?.(
                `${event.effectiveDirective} refused ${event.blockedURI || 'inline'}`,
              );
            },
            true,
          );
        });
      };
      const settle = async (watched: BrowserContext): Promise<void> => {
        if (scriptless.has(watched)) return;
        for (const page of watched.pages()) {
          if (page.isClosed()) continue;
          // A report is delivered after the event that caused it, and in order: a frame, a task,
          // then a mark through the same binding means everything before it has arrived.
          await page.evaluate(async (mark) => {
            const report = window.reportPolicyViolation;
            if (report === undefined) return;
            await new Promise<void>((resolve) => {
              requestAnimationFrame(() => {
                setTimeout(resolve, 0);
              });
            });
            await report(mark);
          }, SETTLED);
        }
      };
      await watch(context, { scripts: javaScriptEnabled });
      await use({ watch, settle });
      await settle(context);
      expect(refused, "the document's security policy refused these").toEqual([]);
    },
    { auto: true },
  ],

  world: async ({ baseURL }, use, testInfo) => {
    // The manifest exists only while the demo harness that serves `baseURL` is up; each project
    // has its own world and so its own manifest.
    if (baseURL === undefined) throw new Error('no baseURL: the demo harness is not configured');
    const path = join(import.meta.dirname, `.world-${testInfo.project.name}.json`);
    await use(JSON.parse(readFileSync(path, 'utf8')) as World);
  },

  signIn: async ({ context, world, baseURL }, use) => {
    await use(async (persona = 'dogancan') => {
      await signInAs(context, baseURL ?? '', world.personas[persona].token);
    });
  },

  tenant: async ({ world, baseURL }, use) => {
    const tokens = {} as Record<Persona, string>;
    const userIds = {} as Record<Persona, string>;
    for (const persona of ['dogancan', 'alice', 'bob', 'carol'] as const) {
      tokens[persona] = world.personas[persona].token;
      userIds[persona] = world.personas[persona].userId;
    }
    await use({
      baseURL: baseURL ?? '',
      slug: world.workspace.slug,
      workspaceId: world.workspace.id,
      tokens,
      userIds,
    });
  },

  api: async ({ tenant }, use) => {
    await use((persona) => apiAs(tenant, persona));
  },

  room: async ({ tenant }, use) => {
    await use((options) => makeRoom(tenant, options));
  },

  asPerson: async ({ browser, baseURL, world, throttling, securityPolicy }, use, testInfo) => {
    const contexts: BrowserContext[] = [];
    await use(async (persona) => {
      const context = await browserLike(browser, baseURL, testInfo);
      contexts.push(context);
      throttling.watch(context);
      await securityPolicy.watch(context);
      await signInAs(context, baseURL ?? '', world.personas[persona].token);
      return await context.newPage();
    });
    // Before they close: what the last action made a page report must not die with it.
    for (const context of contexts) await securityPolicy.settle(context);
    for (const context of contexts) await context.close();
  },

  asOutsider: async ({ browser, baseURL, world, throttling, securityPolicy }, use, testInfo) => {
    const contexts: BrowserContext[] = [];
    await use(async (outsider, session = 0) => {
      const context = await browserLike(browser, baseURL, testInfo);
      contexts.push(context);
      throttling.watch(context);
      await securityPolicy.watch(context);
      const token =
        session === 'fresh'
          ? freshSessionOf(world, outsider)
          : world.outsiders[outsider].tokens[session];
      await signInAs(context, baseURL ?? '', token);
      return await context.newPage();
    });
    for (const context of contexts) await securityPolicy.settle(context);
    for (const context of contexts) await context.close();
  },

  workspaceOf: async ({ world, baseURL }, use, testInfo) => {
    let made = 0;
    await use(async (outsider) => {
      made += 1;
      // Unique across attempts and runs, not only within one: a retry, or a second run against a
      // server that is still up, must not ask for a slug the first one took. What makes it unique
      // comes first, so the 64-character cut never takes it off.
      const slug =
        `${outsider}-${crypto.randomUUID().slice(0, 8)}-${String(testInfo.retry)}-${String(made)}-${testInfo.project.name}`
          .toLowerCase()
          .replace(/[^a-z0-9-]+/g, '-')
          .slice(0, 64);
      const response = await fetch(`${baseURL ?? ''}/api/workspaces`, {
        method: 'POST',
        headers: {
          // A fresh session: a test that signed this outsider out everywhere ended the seeded ones.
          cookie: `${SESSION_COOKIE}=${freshSessionOf(world, outsider)}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ name: slug, slug }),
      });
      if (response.status !== 201) {
        throw new Error(
          `making ${slug} answered ${String(response.status)}: ${await response.text()}`,
        );
      }
      return (await response.json()) as OwnWorkspace;
    });
  },

  newcomer: async ({ browser, baseURL, world, throttling, securityPolicy }, use, testInfo) => {
    const contexts: BrowserContext[] = [];
    const pageSignedInWith = async (token: string): Promise<Page> => {
      const context = await browserLike(browser, baseURL, testInfo);
      contexts.push(context);
      throttling.watch(context);
      await securityPolicy.watch(context);
      await signInAs(context, baseURL ?? '', token);
      return await context.newPage();
    };
    await use(async (label) => {
      // Unique across tests, projects, attempts and runs; within the 39 a username may have.
      const username = `${label}-${crypto.randomUUID().slice(0, 8)}`.toLowerCase().slice(0, 39);
      const { userId, token } = await madePerson(world, username);
      return {
        userId,
        username,
        api: sessionApi({ baseURL: baseURL ?? '', workspaceId: undefined, token, who: username }),
        page: async (): Promise<Page> => await pageSignedInWith(token),
        pageWithAnotherSession: async (): Promise<Page> =>
          await pageSignedInWith(freshSessionOf(world, username)),
      };
    });
    for (const context of contexts) await securityPolicy.settle(context);
    for (const context of contexts) await context.close();
  },

  expectNoAxe: async ({ page }, use) => {
    await use(async (scope) => {
      // The page the scope is on: another person's browser (`newcomer`) is audited as their own.
      const audited = scope?.page() ?? page;
      let builder = new AxeBuilder({ page: audited }).withTags([
        'wcag2a',
        'wcag2aa',
        'wcag21a',
        'wcag21aa',
      ]);
      if (scope !== undefined) builder = builder.include(await scope.evaluate(selectorOf));
      const { violations: found } = await builder.analyze();
      const violations = await withoutRowsOut(audited, found);
      const summary = violations.map(
        (violation) =>
          `${violation.id} (${violation.impact ?? 'unknown'}): ${violation.help}\n` +
          violation.nodes.map((node) => `    ${node.target.join(' ')}`).join('\n'),
      );
      expect(summary, `axe found ${String(violations.length)} violation(s)`).toEqual([]);
    });
  },
});

export { expect };

/** A browser for another person, in this project's colour scheme, window, motion, language and zone. */
const browserLike = async (
  browser: Browser,
  baseURL: string | undefined,
  testInfo: TestInfo,
): Promise<BrowserContext> => {
  const { colorScheme, viewport, reducedMotion, locale, timezoneId } = testInfo.project.use;
  return await browser.newContext({
    ...(baseURL === undefined ? {} : { baseURL }),
    ...(colorScheme === undefined ? {} : { colorScheme }),
    ...(viewport === undefined ? {} : { viewport }),
    ...(reducedMotion === undefined ? {} : { reducedMotion }),
    ...(locale === undefined ? {} : { locale }),
    ...(timezoneId === undefined ? {} : { timezoneId }),
  });
};

/** The cookie a browser holds after signing in: `__Host-` means Secure, host-only, `Path=/`. */
const signInAs = async (context: BrowserContext, baseURL: string, token: string): Promise<void> => {
  await context.addCookies([
    {
      name: SESSION_COOKIE,
      value: token,
      // `domain` + `path` + `secure`, not `url`: for a `__Host-` cookie Chromium accepts the
      // first (measured) and refuses the other, and `localhost` is a secure context.
      domain: new URL(baseURL).hostname,
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    },
  ]);
};

/** A CSS selector for an element, for axe's `include`. */
const selectorOf = (element: Element): string => {
  if (element.id !== '') return `#${element.id}`;
  const parts: string[] = [];
  for (
    let node: Element | null = element;
    node !== null && node.tagName !== 'HTML';
    node = node.parentElement
  ) {
    const siblings = node.parentElement === null ? [] : [...node.parentElement.children];
    parts.unshift(`${node.tagName.toLowerCase()}:nth-child(${String(siblings.indexOf(node) + 1)})`);
  }
  return parts.join(' > ');
};

/**
 * Presses Tab until the locator has focus, and returns how many presses it took — or
 * fails: a control a keyboard cannot reach is a defect, and a number that grows is a
 * page that got longer to cross.
 */
export const tabTo = async (page: Page, target: Locator, limit = 40): Promise<number> => {
  for (let presses = 1; presses <= limit; presses++) {
    await page.keyboard.press('Tab');
    if (await target.evaluate((element) => element === document.activeElement)) return presses;
  }
  throw new Error(`Tab did not reach the element within ${String(limit)} presses`);
};

/** The element that has focus, described the way a screen reader would: role-ish and name. */
export const focused = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const element = document.activeElement;
    if (element === null || element === document.body) return 'body';
    return `${element.tagName.toLowerCase()}${element.id === '' ? '' : `#${element.id}`}: ${
      element.getAttribute('aria-label') ?? element.textContent.trim().slice(0, 40)
    }`;
  });
