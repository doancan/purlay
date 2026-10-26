/**
 * What the native application asked this tab for, kept until the person has answered (D-191).
 *
 * The application opens `/sign-in/native?challenge=…&state=…` in the system browser. A person who is not
 * signed in is sent through the ordinary sign-in first, and GitHub's round trip ends at `/`, a fragment
 * and a query lost on the way — the sign-in has no return path, and D-115 rejected one as an open
 * redirect. So the page does what an invitation's does (`../invitations/pending.ts`): the pair leaves the
 * address as the page reads it and waits in the tab's `sessionStorage`, which outlives the round trip and
 * dies with the tab, and the front door takes the person back to the consent once they are in.
 *
 * Two differences, each for a reason. **It expires**: ten minutes, kept with the time it was made, because
 * a pair is a question somebody asked, and a tab left on a sign-in page for an hour must not answer it
 * when the person comes back to sign in for something else. **The address is a fallback only for a tab
 * whose storage cannot be reached** — an invitation's is looked for there always — so a link that merely
 * happens to carry the two names at `/` is not taken for a question.
 *
 * Neither value is a secret: the challenge is a hash of one, and the state is the application's own word.
 * That is why they may be in a query at all, where an invitation's token must be in a fragment.
 */
import { NATIVE_CHALLENGE_PATTERN, NATIVE_STATE_PATTERN } from '@purlay/types';
import { systemClock } from '../../system-clock';

const KEY = 'purlay.native';
const PATH = '/sign-in/native';

/** How long a tab remembers a question the application asked. */
export const HANDOFF_TTL_MS = 10 * 60 * 1000;

const CHALLENGE = new RegExp(NATIVE_CHALLENGE_PATTERN);
const STATE = new RegExp(NATIVE_STATE_PATTERN);

export interface NativeHandoff {
  readonly challenge: string;
  readonly state: string;
}

/** What this needs of the browser; the caller hands in the real ones, a test its own. */
export interface NativePorts {
  readonly storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
  /** Rewrites the address without a navigation (`history.replaceState`). */
  readonly replace: (url: string) => void;
  readonly now: () => number;
}

const shaped = (pair: { challenge: unknown; state: unknown }): pair is NativeHandoff =>
  typeof pair.challenge === 'string' &&
  typeof pair.state === 'string' &&
  CHALLENGE.test(pair.challenge) &&
  STATE.test(pair.state);

/** The pair an address carries: each name once, each the shape, and nothing else read. */
const fromSearch = (search: string): NativeHandoff | null => {
  const params = new URLSearchParams(search);
  const challenge = params.getAll('challenge');
  const state = params.getAll('state');
  if (challenge.length !== 1 || state.length !== 1) return null;
  const pair = { challenge: challenge[0], state: state[0] };
  return shaped(pair) ? pair : null;
};

/**
 * Called once, as the page loads, before anything routes: `/sign-in/native?challenge=…&state=…` hands its
 * pair to the tab and loses it. Anything else is left alone and means nothing.
 */
export const captureNativeHandoff = (
  location: Pick<Location, 'pathname' | 'search'>,
  ports: NativePorts,
): void => {
  if (location.pathname !== PATH) return;
  const pair = fromSearch(location.search);
  if (pair === null) return;
  // No storage to keep it in: it stays in the address, which is then the only place the screen can read it from.
  if (ports.storage === null) return;
  try {
    ports.storage.setItem(
      KEY,
      JSON.stringify({ challenge: pair.challenge, state: pair.state, at: ports.now() }),
    );
  } catch {
    // A tab that cannot keep it still has it in the address: left there, the screen can read it.
    return;
  }
  ports.replace(PATH);
};

/**
 * A pair that arrived another way — in a sign-in link's fragment, which opened in this tab — kept as one
 * the page was opened with would be. One that is not the shape is not kept. Whether it was kept is answered.
 */
export const keepNativeHandoff = (pair: NativeHandoff, ports: NativePorts): boolean => {
  if (!shaped(pair) || ports.storage === null) return false;
  try {
    ports.storage.setItem(
      KEY,
      JSON.stringify({ challenge: pair.challenge, state: pair.state, at: ports.now() }),
    );
    return true;
  } catch {
    // Unkept: the caller says so to the person, or carries the pair in the address instead.
    return false;
  }
};

/** Used, or answered: the tab forgets it. */
export const forgetNativeHandoff = (ports: NativePorts): void => {
  try {
    ports.storage?.removeItem(KEY);
  } catch {
    // Nothing kept, nothing to forget.
  }
};

/**
 * The question this tab holds, if it is still one: from storage, and no older than ten minutes — or, for a
 * tab whose storage cannot be reached, still in the address.
 */
export const pendingNativeHandoff = (
  ports: NativePorts,
  location: Pick<Location, 'search'>,
): NativeHandoff | null => {
  let kept: string | null;
  try {
    if (ports.storage === null) return fromSearch(location.search);
    kept = ports.storage.getItem(KEY);
  } catch {
    return fromSearch(location.search);
  }
  // Nothing kept: a write may have been refused where a read was not, which left the pair in the address.
  if (kept === null) return fromSearch(location.search);
  let held: unknown;
  try {
    held = JSON.parse(kept);
  } catch {
    return null;
  }
  if (typeof held !== 'object' || held === null) return null;
  const record = held as Readonly<Record<string, unknown>>;
  const at = record['at'];
  if (typeof at !== 'number') return null;
  const age = ports.now() - at;
  // From the future is not a time this tab made.
  if (age < 0) return null;
  if (age >= HANDOFF_TTL_MS) {
    forgetNativeHandoff(ports);
    return null;
  }
  const pair = { challenge: record['challenge'], state: record['state'] };
  return shaped(pair) ? pair : null;
};

/** The browser's own: the tab's storage, if it can be reached, the history's address and the clock. */
export const browserNativePorts = (): NativePorts => {
  let storage: NativePorts['storage'] = null;
  try {
    storage = window.sessionStorage;
  } catch {
    // Blocked storage: the pair stays in the address, where `pendingNativeHandoff` still finds it.
  }
  return {
    storage,
    replace: (url): void => {
      window.history.replaceState(window.history.state, '', url);
    },
    now: (): number => systemClock.now().getTime(),
  };
};
