/**
 * Makes the process a node that predates the stopped modules (D-296): it announces itself in the cluster and serves, and does not say that
 * it reads them, until the file named by `SUSPENSION_GATE` exists. Then it says so, as the node of this release does
 * from the start. Used as `bun --preload` before `apps/api/src/index.ts`, so that the same entry point boots as a node of an
 * older release would have, with nothing in what ships to do it.
 *
 * The one function the entry point calls to say it is rewritten as it is loaded; a source that no longer has the line this
 * rewrites fails the node's start, not the test that waits on it.
 */
import { plugin } from 'bun';

const DECLARATION = 'export const advertiseSuspension = ';
const GATE_POLL_MS = 25;

const gated = `
const advertiseWhenAllowed = (arguments_: Parameters<typeof advertiseEveryTime>[0]): { stop: () => Promise<void> } => {
  let advertising: { stop: () => Promise<void> } | undefined;
  const watch = setInterval(() => {
    if (advertising === undefined && Bun.file(process.env['SUSPENSION_GATE'] ?? '').size > 0) {
      advertising = advertiseEveryTime(arguments_);
    }
  }, ${String(GATE_POLL_MS)});
  return {
    stop: async () => {
      clearInterval(watch);
      await advertising?.stop();
    },
  };
};
export { advertiseWhenAllowed as advertiseSuspension };
`;

plugin({
  name: 'node-without-suspension',
  setup(build) {
    build.onLoad({ filter: /realtime[\\/]entitlement-peers\.ts$/ }, async ({ path }) => {
      const source = await Bun.file(path).text();
      if (!source.includes(DECLARATION)) {
        throw new Error(
          `${path} no longer declares advertiseSuspension the way this preload rewrites it`,
        );
      }
      return {
        contents: source.replace(DECLARATION, 'const advertiseEveryTime = ') + gated,
        loader: 'ts',
      };
    });
  },
});
