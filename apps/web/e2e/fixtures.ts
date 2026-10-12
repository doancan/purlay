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
import {
  test as base,
  expect,
  type BrowserContext,
  type Locator,
  type Page,
} from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  apiAs,
  makeRoom,
  type ApiClient,
  type Persona,
  type Room,
  type RoomOptions,
  type Tenant,
} from './support';

export type { Persona, Room };

/** What `scripts/demo.ts` wrote after seeding (`apps/api/src/cli/demo-seed.ts`). */
interface World {
  readonly workspace: { readonly id: string; readonly slug: string; readonly name: string };
  readonly personas: Readonly<
    Record<Persona, { readonly userId: string; readonly username: string; readonly token: string }>
  >;
  readonly channels: Readonly<
    Record<'api' | 'deploys' | 'incidents' | 'design' | 'security' | 'dmAlice' | 'dmSelf', string>
  >;
  readonly messages: Readonly<Record<string, string>>;
  readonly counts: { readonly messages: number };
}

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
  /** Fails with every violation, named, if axe finds any on the page as it is now. */
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
}

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
      const { colorScheme, viewport, reducedMotion, locale, timezoneId } = testInfo.project.use;
      const context = await browser.newContext({
        ...(baseURL === undefined ? {} : { baseURL }),
        ...(colorScheme === undefined ? {} : { colorScheme }),
        ...(viewport === undefined ? {} : { viewport }),
        ...(reducedMotion === undefined ? {} : { reducedMotion }),
        ...(locale === undefined ? {} : { locale }),
        ...(timezoneId === undefined ? {} : { timezoneId }),
      });
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

  expectNoAxe: async ({ page }, use) => {
    await use(async (scope) => {
      let builder = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']);
      if (scope !== undefined) builder = builder.include(await scope.evaluate(selectorOf));
      const { violations } = await builder.analyze();
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
