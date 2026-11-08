/**
 * `bun run manifests:snapshot`: writes the manifests of the build as the release being cut ships them, to the file
 * `module-compat.test.ts` holds the next release's manifests against (D-250, `MODULES.md` §8). The release script
 * runs it (`scripts/release-prepare.ts`); a release is the only time it is run, and it clears the exceptions.
 */
import { writeFileSync } from 'node:fs';
import { FACTS } from '@purlay/types';
import { bundledModules } from '../composition';
import {
  releasedFactFrom,
  releasedFrom,
  type ReleasedSnapshot,
} from '../platform/module-kit/compatibility';
import { RELEASED_MANIFESTS } from '../released-manifests';

const snapshot: ReleasedSnapshot = {
  manifests: bundledModules.map(({ manifest }) => releasedFrom(manifest)),
  facts: FACTS.map(releasedFactFrom).sort((a, b) => a.type.localeCompare(b.type)),
  exceptions: [],
};
writeFileSync(RELEASED_MANIFESTS, `${JSON.stringify(snapshot, null, 2)}\n`);
