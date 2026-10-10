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

interface Fixtures {
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

  asPerson: async ({ browser, baseURL, world }, use, testInfo) => {
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
      await signInAs(context, baseURL ?? '', world.personas[persona].token);
      return await context.newPage();
    });
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
