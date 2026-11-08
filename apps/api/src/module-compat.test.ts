/**
 * A module's manifest keeps what the last release promised (D-250, `MODULES.md` §8): nothing optional or absent
 * becomes required, no capability, route or job goes, no id changes — unless the break is written down as an
 * exception in `released-manifests.json`, where a reviewer sees it. The release script rewrites that file and
 * clears the exceptions (`bun run manifests:snapshot`). The same holds for a fact: every shape the last release wrote is
 * still read (D-288 §5), so a declaration cannot ship a new shape without the reader of the one before it, and the schema of a shape
 * is the one the release wrote (a fingerprint of each), so a new required field cannot ship under the same shape.
 *
 * The first snapshot was taken from the manifests of the build when it was added: v0.2.0 predates modules, so
 * until the next release this holds the current manifests to themselves.
 */
import { readFileSync } from 'node:fs';
import { expect, test } from 'bun:test';
import { bundledModules } from './composition';
import { FACTS } from '@purlay/types';
import {
  factIncompatibilities,
  incompatibilities,
  unexcused,
  type ReleasedSnapshot,
} from './platform/module-kit/compatibility';
import { RELEASED_MANIFESTS } from './released-manifests';

test('the manifests of the build keep what the last release promised', () => {
  const snapshot = JSON.parse(readFileSync(RELEASED_MANIFESTS, 'utf8')) as ReleasedSnapshot;
  const changes = [
    ...incompatibilities(
      snapshot.manifests,
      bundledModules.map(({ manifest }) => manifest),
    ),
    ...factIncompatibilities(snapshot.facts ?? [], FACTS),
  ];
  expect(unexcused(changes, snapshot)).toEqual([]);
});
