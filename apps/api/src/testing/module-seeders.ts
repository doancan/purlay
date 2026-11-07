/**
 * What the tests that walk every module need written for each (`MODULES.md` §9): a module with a `features/<id>/testing.ts` that
 * exports `seedLifecycle` is seeded by the lifecycle matrix and by the cross-tenant crossing, found by its folder so that a
 * module made by `module:new` is seeded with no edit of either. Chat's and issues' are written out in those tests.
 */
import type { Executor } from '@purlay/db';

export type ModuleSeeder = (database: Executor, workspaceId: string) => Promise<void>;

/** The seeders of the modules that have one, by module id. */
export const moduleSeeders = async (): Promise<ReadonlyMap<string, ModuleSeeder>> =>
  new Map(
    await Promise.all(
      [...new Bun.Glob('features/*/testing.ts').scanSync({ cwd: `${import.meta.dir}/..` })].map(
        async (file): Promise<[string, ModuleSeeder]> => [
          file.split('/')[1] ?? '',
          ((await import(`../${file}`)) as { seedLifecycle: ModuleSeeder }).seedLifecycle,
        ],
      ),
    ),
  );
