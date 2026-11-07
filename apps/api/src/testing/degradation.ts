/**
 * The proof that a module works without a partner it only `optional`ly uses (D-291, `MODULES.md` §4).
 *
 * For every edge of the build, a module and one of its `optional` partners, the build is composed with the partner left out
 * of `MODULES` (and with the modules that require it, which cannot run either), and the module's own scenario runs on that
 * composition. A module writes the scenarios as a `Degradation<typeof manifest>` in `features/<id>/degradation.testing.ts` (test-only code, which production code does not import), so an `optional` added to the manifest is a
 * key the file does not compile without, and `degradation.test.ts` fails for an edge of the bundle with no scenario.
 */
import { composeFor, type BundledModule, type Composition } from '../composition';

/** What a scenario is given: the process as an operator would run it with the partner gone. */
interface DegradedWorld {
  readonly module: string;
  readonly partner: string;
  /** The `MODULES` value of the process: every module but the partner and those that require it. */
  readonly setting: string;
  readonly composition: Composition;
  /** Whether a module runs in this process. */
  readonly runs: (id: string) => boolean;
}

export type DegradationScenario = (world: DegradedWorld) => void | Promise<void>;

/** A module's scenarios: one for each `optional` partner of its manifest, and a manifest that gains one stops compiling until it has its own. */
export type Degradation<Manifest extends { readonly optional: readonly string[] }> = Readonly<
  Record<Manifest['optional'][number], DegradationScenario>
>;

/** All scenarios of a build: module id, then partner id. */
export type Scenarios = Readonly<Record<string, Readonly<Record<string, DegradationScenario>>>>;

export interface DegradationEdge {
  readonly module: string;
  readonly partner: string;
}

export const degradationEdges = (carried: readonly BundledModule[]): DegradationEdge[] =>
  carried.flatMap(({ manifest }) =>
    manifest.optional.map((partner) => ({ module: manifest.id, partner })),
  );

/** The edges with no scenario, and the scenarios with no edge: each as a sentence, none when the two agree. */
export const degradationGaps = (
  carried: readonly BundledModule[],
  scenarios: Scenarios,
): string[] => {
  const edges = degradationEdges(carried);
  const missing = edges
    .filter(({ module, partner }) => scenarios[module]?.[partner] === undefined)
    .map(({ module, partner }) => `"${module}" has no scenario for running without "${partner}"`);
  const stale = Object.entries(scenarios).flatMap(([module, byPartner]) =>
    Object.keys(byPartner)
      .filter(
        (partner) => !edges.some((edge) => edge.module === module && edge.partner === partner),
      )
      .map(
        (partner) =>
          `"${module}" has a scenario for "${partner}", which it does not list as optional`,
      ),
  );
  return [...missing, ...stale];
};

/** The `MODULES` value that leaves `partner` out, and every module that requires it, directly or through another. */
export const settingWithout = (carried: readonly BundledModule[], partner: string): string => {
  const gone = new Set([partner]);
  for (let grew = true; grew;) {
    grew = false;
    for (const { manifest } of carried) {
      if (!gone.has(manifest.id) && manifest.requires.some((required) => gone.has(required))) {
        gone.add(manifest.id);
        grew = true;
      }
    }
  }
  const kept = carried.map(({ manifest }) => manifest.id).filter((id) => !gone.has(id));
  return kept.length === 0 ? 'none' : kept.join(',');
};

export interface DegradationCase {
  readonly name: string;
  readonly run: () => Promise<void>;
}

/** One case for each edge that has a scenario, named `<module> without <partner>`. */
export const degradationCases = (
  carried: readonly BundledModule[],
  scenarios: Scenarios,
): DegradationCase[] =>
  degradationEdges(carried).flatMap(({ module, partner }) => {
    const scenario = scenarios[module]?.[partner];
    if (scenario === undefined) return [];
    const setting = settingWithout(carried, partner);
    return [
      {
        name: `${module} without ${partner}`,
        run: async (): Promise<void> => {
          const composition = composeFor(carried, setting);
          const running = new Set(composition.modules.map((running) => running.manifest.id));
          if (!running.has(module)) {
            throw new Error(
              `"${module}" requires "${partner}" through another module, so it cannot run without it`,
            );
          }
          await scenario({ module, partner, setting, composition, runs: (id) => running.has(id) });
        },
      },
    ];
  });
