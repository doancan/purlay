/**
 * The generator of `testing/degradation.ts`, on a pair of modules made for it: `notes` links to a `wiki` page when `wiki` runs
 * and shows the title it saved when it does not.
 */
import { describe, expect, test } from 'bun:test';
import type { BundledModule } from '../composition';
import {
  degradationCases,
  degradationEdges,
  degradationGaps,
  settingWithout,
  type Degradation,
  type Scenarios,
} from './degradation';

const manifestOf = (
  id: string,
  rest: Partial<BundledModule['manifest']> = {},
): BundledModule['manifest'] => ({
  id,
  requires: [],
  optional: [],
  degrades: {},
  provides: [],
  budget: { none: 'a module of the generator’s test' },
  ...rest,
});

const noop = (): void => undefined;
const noopRun = (): Promise<void> => Promise.resolve();

interface PageLabels {
  readonly labelOf: (pageId: string) => string;
}

const wiki: BundledModule = {
  manifest: manifestOf('wiki', { provides: ['wiki.labels'] }),
  ports: {
    'wiki.labels': { labelOf: (pageId: string): string => `live ${pageId}` } satisfies PageLabels,
  },
};

const notesManifest = manifestOf('notes', {
  optional: ['wiki'],
  degrades: { wiki: 'A link to a page shows the title saved with it, as text.' },
  uses: ['wiki.labels'],
});
const notes: BundledModule = { manifest: notesManifest };

/** What `notes` draws for a link: the page's own label where `wiki` runs, the saved one where it does not. */
const linkText = (labels: PageLabels | undefined, pageId: string, saved: string): string =>
  labels?.labelOf(pageId) ?? saved;

const scenarios = {
  notes: {
    wiki: ({ composition, runs }): void => {
      expect(runs('wiki')).toBe(false);
      const labels = composition.ports['wiki.labels'] as PageLabels | undefined;
      expect(linkText(labels, 'p1', 'Saved title')).toBe('Saved title');
    },
  } satisfies Degradation<typeof notesManifest>,
};

/** What a case came to: `passed`, or the words it failed with. */
const resultOf = async (run: () => Promise<void>): Promise<string> =>
  await run().then(
    () => 'passed',
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );

describe('the cases the generator makes', () => {
  test('are one for each optional edge, run with the partner out of MODULES', async () => {
    const cases = degradationCases([wiki, notes], scenarios);
    expect(cases.map(({ name }) => name)).toEqual(['notes without wiki']);
    await Promise.all(cases.map(({ run }) => run()));
  });

  test('fail when the module misbehaves without its partner', async () => {
    const broken: Scenarios = {
      notes: {
        wiki: ({ composition }): void => {
          const labels = composition.ports['wiki.labels'] as PageLabels | undefined;
          // Reads the port as if it were always there.
          expect(labels!.labelOf('p1')).toBe('Saved title');
        },
      },
    };
    const [only] = degradationCases([wiki, notes], broken);
    expect(await resultOf(only?.run ?? noopRun)).not.toBe('passed');
  });

  test('are the module-partner pairs of the manifests', () => {
    expect(degradationEdges([wiki, notes])).toEqual([{ module: 'notes', partner: 'wiki' }]);
  });
});

describe('the gaps', () => {
  test('an edge with no scenario is named, and so is a scenario for an edge that is gone', () => {
    expect(degradationGaps([wiki, notes], {})).toEqual([
      '"notes" has no scenario for running without "wiki"',
    ]);
    expect(degradationGaps([wiki, notes], { notes: { wiki: noop, mail: noop } })).toEqual([
      '"notes" has a scenario for "mail", which it does not list as optional',
    ]);
    expect(degradationGaps([wiki, notes], scenarios)).toEqual([]);
  });

  test('a build with no optional edge needs no scenario', () => {
    expect(degradationGaps([wiki], {})).toEqual([]);
  });
});

describe('the setting that leaves a partner out', () => {
  const tasks: BundledModule = { manifest: manifestOf('tasks', { requires: ['wiki'] }) };
  const report: BundledModule = { manifest: manifestOf('report', { requires: ['tasks'] }) };

  test('also leaves out what requires it, directly or through another module', () => {
    expect(settingWithout([wiki, notes, tasks, report], 'wiki')).toBe('notes');
  });

  test('is none when nothing is left', () => {
    expect(settingWithout([wiki, tasks], 'wiki')).toBe('none');
  });

  test('refuses a module that cannot run without the partner through another module', async () => {
    const stuck: BundledModule = {
      manifest: manifestOf('stuck', {
        optional: ['wiki'],
        requires: ['tasks'],
        degrades: { wiki: 'x' },
      }),
    };
    const [only] = degradationCases([wiki, tasks, stuck], { stuck: { wiki: noop } });
    expect(await resultOf(only?.run ?? noopRun)).toBe(
      '"stuck" requires "wiki" through another module, so it cannot run without it',
    );
  });
});
