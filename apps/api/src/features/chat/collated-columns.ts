/**
 * The columns chat's migrations declare `COLLATE "C"` (D-40, D-250): what readiness checks beside the core's,
 * so a schema restored without the clause is not called ready. The test that scans the migrations holds this
 * list to them.
 */
import type { CollatedColumn } from '../../platform/readiness';

export const CHAT_COLLATED_COLUMNS: readonly CollatedColumn[] = [
  ['channels', 'name'],
  ['github_repo_feeds', 'repository_full_name'],
  ['github_deliveries', 'delivery_id'],
  ['github_app_handshakes', 'state_digest'],
  ['github_app_deliveries', 'delivery_id'],
  ['github_app_deliveries', 'body_digest'],
  ['github_operations', 'content_digest'],
  ['github_operations', 'marker'],
];
