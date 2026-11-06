/**
 * The source the application's routes are written in: `ingress/http/app.ts` and, for each module that keeps its HTTP in its own
 * folder (D-280), the production files of `features/<id>/http/`. The tests that read the routes as text — the endpoint table,
 * the ownership of each path — read it through here, so a route is found where it is registered.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const API_SOURCE = resolve(import.meta.dir, '..');

/** The files of a module's HTTP folder, absolute, tests left out; none where it has no folder. */
export const httpFolderFiles = (id: string): string[] => {
  const folder = join(API_SOURCE, 'features', id, 'http');
  if (!existsSync(folder)) return [];
  return readdirSync(folder, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
    .map((file) => join(folder, file))
    .sort();
};

/** Every file a route of the application is registered in. */
export const routeSourceFiles = (): string[] => [
  join(API_SOURCE, 'ingress', 'http', 'app.ts'),
  ...readdirSync(join(API_SOURCE, 'features'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => httpFolderFiles(entry.name)),
];

/** The text of those files, joined. */
export const routeSource = (): string =>
  routeSourceFiles()
    .map((file) => readFileSync(file, 'utf8'))
    .join('\n');
