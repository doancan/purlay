/**
 * __PASCAL__, as a module (`MODULES.md` §11): its manifest and what it contributes to the places the core leaves open.
 * Its data is held whether or not it runs, as every bundled module's is (`composition.ts`).
 */
import type { WorkspacePurge } from '../../modules/workspaces/deletion-purge';
import { __CAMEL__Budget } from './budget';
import { __CAMEL__Export } from './export';
import { __CAMEL__Routes } from './http/routes';
import { __CAMEL__PersonalExport } from './personal-export';
import { __CAMEL__Workers } from './workers';

/** A purged workspace keeps its row as a tombstone and the cascade never fires, so the purge names the table. */
const __CAMEL__WorkspacePurge: WorkspacePurge = { before: [], after: [], tables: ['__SNAKE__'] };

export const __CAMEL__Module = {
  manifest: {
    id: '__ID__',
    requires: [__REQUIRES__],
    optional: [__OPTIONAL__],
    degrades: {__DEGRADES__},
    provides: [],
    budget: { poolShare: __CAMEL__Budget },
    routes: ['/api/workspaces/:workspaceId/__ID__'],
    jobs: [],
  },
  workspacePurge: __CAMEL__WorkspacePurge,
  export: __CAMEL__Export,
  personalExport: __CAMEL__PersonalExport,
  routes: __CAMEL__Routes,
  workers: __CAMEL__Workers,
};
