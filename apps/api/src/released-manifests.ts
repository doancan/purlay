import { join } from 'node:path';

/** Where the manifests of the last release are kept (`platform/module-kit/compatibility.ts`). */
export const RELEASED_MANIFESTS = join(import.meta.dir, 'released-manifests.json');
