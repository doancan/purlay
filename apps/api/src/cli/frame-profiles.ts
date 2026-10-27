/**
 * The synthetic measurement that closed O-4 (D-198): what a page sends in the cases that could meet the
 * frame budget, through the limiter the server runs. `realtime/frame-profiles.ts` has the profiles.
 *
 *   bun run measure:frames
 */
import { SOCKET_FRAME_BUDGET } from '../realtime/rate-limiter';
import { measureAll, table } from '../realtime/frame-profiles';

if (import.meta.main) {
  for (const line of table(await measureAll(SOCKET_FRAME_BUDGET), SOCKET_FRAME_BUDGET)) {
    console.log(line);
  }
}
