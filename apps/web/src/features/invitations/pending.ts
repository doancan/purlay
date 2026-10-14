/**
 * The invitation a tab was opened with (D-115), kept for that tab until it is used.
 *
 * An invitation is `/invite#<token>`. The token is a secret, so it leaves the address bar the moment
 * the page loads — not left in the history, a screenshot or a shared screen — and waits in the tab's
 * `sessionStorage`, which outlives the round trip through GitHub's sign-in (that comes back to `/`,
 * and a fragment does not survive it) and dies with the tab. Nothing about it is ever in a path or a
 * query, which a server would log.
 */

const KEY = 'purlay.invitation';
const TOKEN = /^[0-9a-f]{64}$/;

/** What this needs of the browser; the caller hands in the real ones, a test its own. */
export interface InvitationPorts {
  readonly storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
  /** Rewrites the address without a navigation (`history.replaceState`). */
  readonly replace: (url: string) => void;
}

/**
 * Called once, as the page loads, before anything routes: an `/invite#token` address hands its token
 * to the tab and loses it. A fragment that is not a token is left alone and means nothing.
 */
export const captureInvitation = (
  location: Pick<Location, 'pathname' | 'hash'>,
  ports: InvitationPorts,
): void => {
  if (location.pathname !== '/invite') return;
  const token = location.hash.replace(/^#/, '');
  if (!TOKEN.test(token)) return;
  try {
    ports.storage?.setItem(KEY, token);
  } catch {
    // A tab that cannot keep it still has it in the address: left there, the screen can read it.
    return;
  }
  ports.replace('/invite');
};

/**
 * An invitation that arrived another way — in a sign-in link's fragment (D-138 §4) — kept for this tab
 * as one opened here would be. One that is not a token is not kept.
 */
export const keepInvitation = (token: string, ports: InvitationPorts): void => {
  if (!TOKEN.test(token)) return;
  try {
    ports.storage?.setItem(KEY, token);
  } catch {
    // Unkept: the person opens the invitation again, which still works until it expires.
  }
};

/** The token this tab holds, if any — from storage, or still in the address if storage refused it. */
export const pendingInvitation = (
  ports: InvitationPorts,
  location: Pick<Location, 'hash'>,
): string | null => {
  try {
    const kept = ports.storage?.getItem(KEY) ?? null;
    if (kept !== null && TOKEN.test(kept)) return kept;
  } catch {
    // Unreadable storage: fall through to the address.
  }
  const inAddress = location.hash.replace(/^#/, '');
  return TOKEN.test(inAddress) ? inAddress : null;
};

/** Used, or found not to open: the tab forgets it. */
export const forgetInvitation = (ports: InvitationPorts): void => {
  try {
    ports.storage?.removeItem(KEY);
  } catch {
    // Nothing kept, nothing to forget.
  }
};

/** The browser's own: the tab's storage, if it can be reached, and the history's address. */
export const browserInvitationPorts = (): InvitationPorts => {
  let storage: InvitationPorts['storage'] = null;
  try {
    storage = window.sessionStorage;
  } catch {
    // Blocked storage: the token stays in the address, where `pendingInvitation` still finds it.
  }
  return {
    storage,
    replace: (url): void => {
      window.history.replaceState(window.history.state, '', url);
    },
  };
};
