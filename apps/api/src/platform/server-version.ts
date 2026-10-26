/**
 * The version this server was built as: the root manifest's, which is its one home (D-185). Read at
 * import, once, from the file the image carries beside the sources (`Dockerfile`: `COPY package.json`),
 * so the answer to "which server is this" is never a second copy that can disagree with the release.
 */
import manifest from '../../../../package.json' with { type: 'json' };

export const SERVER_VERSION: string = manifest.version;
