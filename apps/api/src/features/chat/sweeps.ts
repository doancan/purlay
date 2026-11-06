/**
 * The sweeps of the rows chat keeps (D-23, D-134 §5, D-246): the unfurl cache and the ids of what GitHub delivered.
 * Chat's tables are in the core's first migrations, so these keep running whether or not chat does — they are the
 * scheduler's jobs, not the manifest's (`MODULES.md` §3) — and what they delete is why they are chat's code and not
 * the jobs module's (D-250).
 */
import { DAY_MS, type Clock } from '../../platform/clock';
import type { ChatDb } from './schema';

/**
 * `sweep:link-previews` (D-23): the unfurl cache past its expiry. The expiry is also enforced where
 * the cache is read, so a sweep that did not run serves nothing stale — it only lets the table grow.
 */
export const sweepLinkPreviews = async (dependencies: {
  readonly database: ChatDb;
  readonly clock: Clock;
}): Promise<{ removed: number }> => {
  const result = await dependencies.database
    .deleteFrom('link_previews')
    .where('expires_at', '<=', dependencies.clock.now())
    .executeTakeFirst();
  return { removed: Number(result.numDeletedRows) };
};

/** How long a delivery's id is kept: GitHub redelivers only the last three days, so this is a margin. */
export const GITHUB_DELIVERIES_KEPT_DAYS = 30;

/**
 * Forgets the ids of deliveries older than `GITHUB_DELIVERIES_KEPT_DAYS` (D-134 §5): what makes a
 * redelivery post nothing, needed only while GitHub can still send one again — the feeds' and the GitHub
 * App's (D-246) — and, with them, the handshakes of trips to GitHub that were never brought back and the
 * records of creating an issue (D-246 §4). Bounded by
 * the indexes on `received_at` and `expires_at`; idempotent, as every job is (D-30).
 */
export const sweepGitHubDeliveries = async (dependencies: {
  readonly database: ChatDb;
  readonly clock: Clock;
}): Promise<{ removed: number }> => {
  const before = new Date(
    dependencies.clock.now().getTime() - GITHUB_DELIVERIES_KEPT_DAYS * DAY_MS,
  );
  const feeds = await dependencies.database
    .deleteFrom('github_deliveries')
    .where('received_at', '<', before)
    .executeTakeFirst();
  const app = await dependencies.database
    .deleteFrom('github_app_deliveries')
    .where('received_at', '<', before)
    .executeTakeFirst();
  const over = dependencies.clock.now();
  const trips = await dependencies.database
    .deleteFrom('github_app_handshakes')
    .where('expires_at', '<=', over)
    .executeTakeFirst();
  // The record of creating an issue is as long as a lost answer can still be looked for (D-246 §4).
  const operations = await dependencies.database
    .deleteFrom('github_operations')
    .where('updated_at', '<', before)
    .executeTakeFirst();
  return {
    removed:
      Number(feeds.numDeletedRows) +
      Number(app.numDeletedRows) +
      Number(trips.numDeletedRows) +
      Number(operations.numDeletedRows),
  };
};
