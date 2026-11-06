/**
 * Installing a browser for the end-to-end suite, with a stall cut and tried again (#1141). The download
 * and the system packages come from mirrors that sometimes stall for the whole job; each try is given
 * a time and then stopped. What starts the process is `scripts/install-browser.ts`; this is the rule.
 */
export type Outcome = 'done' | 'failed' | 'stalled';

/** Runs the install and says how it ended; a run that outlives `limitMs` is stopped and is `stalled`. */
export type Run = (limitMs: number) => Promise<Outcome>;

export const TRIES = 3;
export const TRY_LIMIT_MS = 180_000;

/** The exit code: 0 when a try finished, 1 when every try failed or stalled. */
export const installWithRetries = async (
  browser: string,
  run: Run,
  say: (line: string) => void,
  tries: number = TRIES,
  limitMs: number = TRY_LIMIT_MS,
): Promise<number> => {
  for (let attempt = 1; attempt <= tries; attempt += 1) {
    const outcome = await run(limitMs);
    if (outcome === 'done') return 0;
    say(`installing ${browser}, try ${String(attempt)} of ${String(tries)}: ${outcome}`);
  }
  return 1;
};

/** The command a try runs: the playwright the lockfile pins, from the web workspace (#1099). */
export const installCommand = (browser: string): string[] => [
  'bun',
  '--no-env-file',
  'run',
  '--cwd',
  'apps/web',
  'playwright',
  'install',
  '--with-deps',
  browser,
];

const BROWSERS = ['chromium', 'webkit'] as const;
export type Browser = (typeof BROWSERS)[number];

/** `undefined` for anything but a browser the suite installs. */
export const browserOf = (argument: string | undefined): Browser | undefined =>
  BROWSERS.find((browser) => browser === argument);
