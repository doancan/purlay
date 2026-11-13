/** Scoped factors reuse Better Auth's HOTP primitive while keeping verification time explicit. */
import { createOTP } from '@better-auth/utils/otp';
import {
  WORKSPACE_MFA_CODE_DIGITS as DIGITS,
  WORKSPACE_MFA_PERIOD_SECONDS as PERIOD_SECONDS,
  WORKSPACE_MFA_SECRET_BYTES as SECRET_BYTES,
} from '@purlay/types/workspace-security';
import { timingSafeEqual } from 'node:crypto';

export interface WorkspaceTotpSetup {
  readonly secret: Uint8Array;
  readonly uri: string;
}

/** The caller encrypts the secret and exposes the URI only in its authorized one-time setup. */
export const createWorkspaceTotp = (account: string): WorkspaceTotpSetup => {
  const secret = crypto.getRandomValues(new Uint8Array(SECRET_BYTES));
  return {
    secret,
    uri: createOTP(secret, { digits: DIGITS, period: PERIOD_SECONDS }).url('Purlay', account),
  };
};

/**
 * Returns the actual matching counter, rather than a boolean or the wall-clock step. The caller must
 * atomically consume that counter with the current factor, challenge, session and workspace policy.
 */
export const matchingWorkspaceTotpCounter = async (
  secret: Uint8Array,
  code: string,
  now: Date,
): Promise<number | null> => {
  const milliseconds = now.getTime();
  if (
    code.length !== DIGITS ||
    /[^0-9]/u.test(code) ||
    !Number.isFinite(milliseconds) ||
    milliseconds < 0
  )
    return null;
  const counter = Math.floor(milliseconds / (PERIOD_SECONDS * 1_000));
  const otp = createOTP(secret, { digits: DIGITS, period: PERIOD_SECONDS });
  const presented = Buffer.from(code, 'ascii');
  let matched: number | null = null;
  // Inspect the whole public time window, including after a match. Negative epoch steps do not exist.
  for (let candidate = Math.max(0, counter - 1); candidate <= counter + 1; candidate += 1) {
    if (timingSafeEqual(presented, Buffer.from(await otp.hotp(candidate), 'ascii')))
      matched = candidate;
  }
  return matched;
};
