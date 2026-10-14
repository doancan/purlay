/**
 * `storage-init`: the one-shot service of `docker-compose.production.yml` that prepares the object
 * store before the API starts (#76, D-144). What it does is `platform/storage-setup.ts`; this reads
 * the environment, says what was done, and exits non-zero — holding the API back — when the store is
 * not ready. Nothing secret is printed.
 */
import { initStorage, settingsFrom } from '../platform/storage-setup';

try {
  const settings = settingsFrom(process.env);
  const done = await initStorage(settings, fetch);
  console.log(
    done.length === 0
      ? `storage: ready (bucket ${settings.bucket}, key ${settings.accessKeyId}); nothing to do`
      : `storage: ${done.join(', ')} set up (bucket ${settings.bucket}, key ${settings.accessKeyId})`,
  );
} catch (error) {
  console.error(`storage: not ready — ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
