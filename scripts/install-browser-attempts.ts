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
  afterStall: () => Promise<void> = () => Promise.resolve(),
): Promise<number> => {
  for (let attempt = 1; attempt <= tries; attempt += 1) {
    const outcome = await run(limitMs);
    if (outcome === 'done') return 0;
    say(`installing ${browser}, try ${String(attempt)} of ${String(tries)}: ${outcome}`);
    // Stopping the playwright that started apt does not stop apt: the `apt-get` it left holds the dpkg
    // lock, and the next try waits for it until it gives up (#1141, seen on main).
    if (outcome === 'stalled') await afterStall();
  }
  return 1;
};

/**
 * What a runner does after a stalled try, so that the next one starts clean: stop the `apt-get` the
 * stopped try left (it was in its download, or hung), then finish any package the stop interrupted.
 */
export const AFTER_STALL_COMMANDS: readonly (readonly string[])[] = [
  ['sudo', 'pkill', '-KILL', '-x', 'apt-get'],
  ['sudo', 'pkill', '-KILL', '-x', 'apt'],
  ['sudo', 'dpkg', '--configure', '-a'],
];

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

/**
 * What the CI runner's apt is told before an install: give up on a mirror that stalls (the download is
 * the part that hangs), and wait for the dpkg lock when an earlier try left its `apt-get` behind. A
 * try stopped by the clock stops the playwright that started apt, not apt itself: the first CI run of
 * this retry saw tries two and three refused by the lock the stopped try's `apt-get` still held.
 */
export const APT_TIMEOUTS = [
  'Acquire::http::Timeout "20";',
  'Acquire::https::Timeout "20";',
  'Acquire::Retries "3";',
  'DPkg::Lock::Timeout "120";',
  '',
].join('\n');

export const APT_TIMEOUTS_FILE = '/etc/apt/apt.conf.d/99purlay-timeouts';
