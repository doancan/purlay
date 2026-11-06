/**
 * `bun run test:e2e:install` and `test:e2e:install:webkit`: install a browser for the end-to-end suite,
 * a stalled try cut at three minutes and tried again, three times (#1141). The rule and its tests are
 * `scripts/install-browser-attempts.ts`; this only starts the process.
 */
import {
  AFTER_STALL_COMMANDS,
  APT_TIMEOUTS,
  APT_TIMEOUTS_FILE,
  browserOf,
  installCommand,
  installWithRetries,
  type Outcome,
} from './install-browser-attempts';

const browser = browserOf(process.argv[2]);
if (browser === undefined) {
  console.error('usage: bun run scripts/install-browser.ts <chromium|webkit>');
  process.exit(2);
}

// On a CI runner, apt is told first not to hang on a mirror (see `APT_TIMEOUTS`).
if (process.env['CI'] === 'true') {
  const config = Bun.spawn(['sudo', 'tee', APT_TIMEOUTS_FILE], {
    stdin: new Response(APT_TIMEOUTS),
    stdout: 'ignore',
    stderr: 'inherit',
  });
  await config.exited;
}

process.exit(
  await installWithRetries(
    browser,
    async (limitMs): Promise<Outcome> => {
      const stop = AbortSignal.timeout(limitMs);
      const child = Bun.spawn(installCommand(browser), {
        stdout: 'inherit',
        stderr: 'inherit',
        signal: stop,
      });
      const code = await child.exited;
      if (stop.aborted) return 'stalled';
      return code === 0 ? 'done' : 'failed';
    },
    console.error,
    undefined,
    undefined,
    async () => {
      if (process.env['CI'] !== 'true') return;
      for (const command of AFTER_STALL_COMMANDS) {
        // A command that finds nothing to stop exits non-zero; that is the usual case, not a failure.
        await Bun.spawn([...command], { stdout: 'inherit', stderr: 'inherit' }).exited;
      }
    },
  ),
);
