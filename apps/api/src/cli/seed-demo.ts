/**
 * Seed the demo workspace into the database `DATABASE_URL` names, and say where the
 * manifest went.
 *
 *   DATABASE_URL=postgres://… bun run apps/api/src/cli/seed-demo.ts --out demo.json
 *
 * **It uses that database and no other, and only an empty one.** The demo people are
 * created by name, so a second run against the same database is refused rather than
 * duplicated; `scripts/demo.ts` drops and recreates its own scratch database each time,
 * which is how a demo stays repeatable without this file ever being pointed at a
 * database somebody cares about.
 *
 * Not imported by anything that ships: it is a development tool, like
 * `write-env-example.ts`, and lives in `cli/` for the same reason.
 */
import { writeFileSync } from 'node:fs';
import { createDatabase } from '@purlay/db';
import { systemClock } from '../platform/clock';
import { loadConfig } from '../platform/config';
import { seedDemo } from './demo-seed';

const flag = (name: string): string | undefined => {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
};

/** Seeds the database `DATABASE_URL` names. */
export const run = async (): Promise<void> => {
  const out = flag('--out');
  const config = loadConfig({
    // The seed never listens or signs in, so these only have to be well-formed.
    APP_URL: 'http://localhost:4173',
    GITHUB_CLIENT_ID: 'demo',
    GITHUB_CLIENT_SECRET: 'demo',
    ENCRYPTION_KEY: 'ZGV2ZWxvcG1lbnQtb25seS1rZXktMzItYnl0ZXMhISE=',
    ...process.env,
  });

  const database = createDatabase({ connectionString: config.DATABASE_URL, poolSize: 4 });
  try {
    const manifest = await seedDemo({ database, config, now: systemClock.now() });
    const json = JSON.stringify(manifest, null, 2);
    if (out === undefined) {
      process.stdout.write(`${json}\n`);
    } else {
      writeFileSync(out, `${json}\n`);
      process.stdout.write(
        `seeded ${String(manifest.counts.messages)} messages into ${new URL(config.DATABASE_URL).pathname.slice(1)}; manifest: ${out}\n`,
      );
    }
  } finally {
    await database.destroy();
  }
};

await run();
