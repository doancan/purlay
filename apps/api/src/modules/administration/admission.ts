/** Admission is independent of workspace roles. Old accounts are grandfathered; invitation is not an exemption. */
import { setupStatus } from '../setup/setup';
import type { Executor, Transaction } from '@purlay/db';
import type {
  AdmissionState,
  InstanceInfo,
  ServerPreferences,
  ServerPreferencesRequest,
} from '@purlay/types';
import type { Clock } from '../../platform/clock';
import { AppError } from '../../platform/errors';
import { recordServerAudit } from '../audit/server-audit';
import { revokeAllSessions } from '../auth/sessions';
import type { ServerAdminSession } from '../setup/setup';
import { lockServerAdministrator } from './changes';

export const readServerPreferences = async (db: Executor): Promise<ServerPreferences> => {
  const row = await db
    .selectFrom('server_settings')
    .select([
      'allowed_email_domains',
      'require_account_approval',
      'display_name',
      'support_url',
      'privacy_url',
      'terms_url',
    ])
    .where('id', '=', true)
    .executeTakeFirst();
  return {
    allowedEmailDomains: row?.allowed_email_domains ?? [],
    requireAccountApproval: row?.require_account_approval ?? false,
    displayName: row?.display_name ?? 'Purlay',
    supportUrl: row?.support_url ?? null,
    privacyUrl: row?.privacy_url ?? null,
    termsUrl: row?.terms_url ?? null,
  };
};
/** Intentionally public: server identity and joining requirements. */
export const instanceInfo = async (db: Executor): Promise<InstanceInfo> =>
  await readServerPreferences(db);
export const emailDomainAllowed = (email: string, allowed: readonly string[]): boolean =>
  allowed.length === 0 || allowed.includes(email.slice(email.lastIndexOf('@') + 1).toLowerCase());

/** The library's user includes our non-input columns. Missing fields occur in pre-upgrade test doubles. */
export const admissionStateOf = (user: unknown): AdmissionState | 'verify-email' => {
  if (typeof user !== 'object' || user === null) return 'approved';
  if (
    'admissionState' in user &&
    (user.admissionState === 'pending' || user.admissionState === 'denied')
  )
    return user.admissionState;
  if (
    'admissionRequiresVerifiedEmail' in user &&
    user.admissionRequiresVerifiedEmail === true &&
    (!('emailVerified' in user) || user.emailVerified !== true)
  )
    return 'verify-email';
  return 'approved';
};

const optionalAddress = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
};

const validLegalAddress = (value: string | null): boolean => {
  if (value === null) return true;
  // Require an explicit HTTPS origin and refuse URL-parser repairs of whitespace or slashes.
  if (!/^https:\/\/[^/\\]/i.test(value) || /[\s\u0000-\u001f\u007f\\]/.test(value)) return false;
  const url = URL.parse(value);
  return url !== null && url.hostname !== '' && url.username === '' && url.password === '';
};

export const changeServerPreferences = async (
  tx: Transaction,
  clock: Clock,
  admin: ServerAdminSession,
  input: ServerPreferencesRequest,
): Promise<void> => {
  await lockServerAdministrator(tx, admin);
  if ((await setupStatus(tx)) === 'open')
    throw new AppError({
      code: 'FORBIDDEN',
      message: 'Finish the setup before changing administration preferences.',
    });
  const before = await readServerPreferences(tx);
  const change = { ...before, ...input };
  const name = change.displayName.trim();
  const support = optionalAddress(change.supportUrl);
  const privacy = optionalAddress(change.privacyUrl);
  const terms = optionalAddress(change.termsUrl);
  let validSupport = support === null;
  if (support !== null) {
    try {
      const url = new URL(support);
      validSupport =
        (url.protocol === 'https:' &&
          url.hostname !== '' &&
          url.username === '' &&
          url.password === '') ||
        (url.protocol === 'mailto:' &&
          /^[^\s@?]+@[^\s@?]+\.[^\s@?]+$/.test(url.pathname) &&
          url.search === '' &&
          url.hash === '');
    } catch {
      validSupport = false;
    }
  }
  const invalidName = name === '' || /[\u0000-\u001f\u007f]/.test(name);
  const validPrivacy = validLegalAddress(privacy);
  const validTerms = validLegalAddress(terms);
  if (invalidName || !validSupport || !validPrivacy || !validTerms)
    throw new AppError({
      code: 'VALIDATION_FAILED',
      message: 'Check the server identity.',
      details: {
        fields: {
          ...(invalidName ? { displayName: 'A name without control characters is required.' } : {}),
          ...(!validSupport
            ? { supportUrl: 'Use an HTTPS address or a plain mailto address.' }
            : {}),
          ...(!validPrivacy ? { privacyUrl: 'Use an HTTPS address.' } : {}),
          ...(!validTerms ? { termsUrl: 'Use an HTTPS address.' } : {}),
        },
      },
    });
  const domains = [
    ...new Set(change.allowedEmailDomains.map((domain) => domain.toLowerCase())),
  ].sort();
  const policyChanged =
    before.requireAccountApproval !== change.requireAccountApproval ||
    before.allowedEmailDomains.join(',') !== domains.join(',');
  const identityChanged =
    before.displayName !== name ||
    before.supportUrl !== support ||
    before.privacyUrl !== privacy ||
    before.termsUrl !== terms;
  if (!policyChanged && !identityChanged) return;
  const patch = {
    allowed_email_domains: domains,
    require_account_approval: change.requireAccountApproval,
    display_name: name,
    support_url: support,
    privacy_url: privacy,
    terms_url: terms,
    updated_at: clock.now(),
  };
  await tx
    .insertInto('server_settings')
    .values({ id: true, ...patch })
    .onConflict((conflict) => conflict.column('id').doUpdateSet(patch))
    .execute();
  if (policyChanged)
    await recordServerAudit(tx, clock, {
      actorUserId: admin.userId,
      action: 'server.admission_policy_changed',
    });
  if (identityChanged)
    await recordServerAudit(tx, clock, {
      actorUserId: admin.userId,
      action: 'server.identity_changed',
    });
};

export const decideAdmission = async (
  tx: Transaction,
  clock: Clock,
  admin: ServerAdminSession,
  userId: string,
  decision: 'approved' | 'denied',
  pendingOnly = false,
): Promise<readonly string[]> => {
  await lockServerAdministrator(tx, admin);
  // Sessions before the account row, as content writers lock them (D-85).
  await tx
    .selectFrom('sessions')
    .select('id')
    .where('user_id', '=', userId)
    .orderBy('id')
    .forUpdate()
    .execute();
  const user = await tx
    .selectFrom('users')
    .select(['admission_state', 'is_server_admin'])
    .where('id', '=', userId)
    .where('deleted_at', 'is', null)
    .forUpdate()
    .executeTakeFirst();
  if (user === undefined)
    throw new AppError({ code: 'USER_NOT_FOUND', message: 'No such account.' });
  if (user.admission_state === decision) return [];
  if (pendingOnly && user.admission_state !== 'pending')
    throw new AppError({
      code: 'FORBIDDEN',
      message: 'The account is no longer awaiting approval.',
    });
  if (user.is_server_admin || (user.admission_state === 'approved' && decision === 'denied'))
    throw new AppError({ code: 'FORBIDDEN', message: 'Suspend an admitted account instead.' });
  await tx
    .updateTable('users')
    .set({ admission_state: decision, updated_at: clock.now() })
    .where('id', '=', userId)
    .execute();
  const ended = decision === 'denied' ? await revokeAllSessions(tx, userId) : [];
  await recordServerAudit(tx, clock, {
    actorUserId: admin.userId,
    action: decision === 'approved' ? 'server.account_approved' : 'server.account_denied',
    targetUserId: userId,
  });
  return ended;
};
