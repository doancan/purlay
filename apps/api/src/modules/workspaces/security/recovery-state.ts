/** Recovery availability predicts only native configured paths; it never verifies credentials or creates a session. */
import type { AuthMethods } from '@purlay/types';
import type { Database, Executor, Selectable, Transaction } from '@purlay/db';
import { madeByGitHub, madeByGoogle } from '../../auth/magic-link';
import { GOOGLE_PROVIDER_ID } from '../../auth/google';
import { OIDC_PROVIDER_ID } from '../../auth/oidc';
import { tokenDigest } from '../../../platform/tokens';
import { securityNotReady, type LockedWorkspaceSecurityActor } from './authority';
import type { WorkspacePolicyDependencies } from './policy-authority';

const NO_POLICY_RECOVERY_REVISION = '00000000-0000-4000-8000-000000000000';
type RecoveryPerson = Pick<
  Selectable<Database['users']>,
  'id' | 'github_id' | 'github_login' | 'github_connected_at' | 'google_made'
>;
interface RecoveryMethods {
  readonly password: boolean;
  readonly email_link: boolean;
  readonly github: boolean;
  readonly server_oidc: boolean;
  readonly google: boolean;
}

/** Same native provider IDs and email-eligibility helpers as mySignIn; only public booleans leave this module. */
const availableMethods = (
  person: RecoveryPerson,
  providers: ReadonlySet<string>,
  enabled: AuthMethods,
): RecoveryMethods => ({
  password: enabled.password && providers.has('credential'),
  email_link: enabled.email && !madeByGitHub(person) && !(enabled.google && madeByGoogle(person)),
  github: enabled.github && person.github_id !== null,
  server_oidc: enabled.oidc !== null && providers.has(OIDC_PROVIDER_ID),
  google: enabled.google && providers.has(GOOGLE_PROVIDER_ID),
});

const accountMethods = async (
  database: Executor,
  userIds: readonly string[],
): Promise<ReadonlyMap<string, ReadonlySet<string>>> => {
  const result = new Map<string, Set<string>>();
  if (userIds.length === 0) return result;
  const accounts = await database
    .selectFrom('accounts')
    .select(['user_id', 'provider_id'])
    .where('user_id', 'in', userIds)
    .where('provider_id', 'in', ['credential', OIDC_PROVIDER_ID, GOOGLE_PROVIDER_ID])
    .where((expression) =>
      expression.or([
        expression('provider_id', '!=', 'credential'),
        expression('password', 'is not', null),
      ]),
    )
    .execute();
  for (const account of accounts) {
    const set = result.get(account.user_id) ?? new Set<string>();
    set.add(account.provider_id);
    result.set(account.user_id, set);
  }
  return result;
};

export const requireIndependentRecoveryMethod = async (
  transaction: Transaction,
  dependencies: WorkspacePolicyDependencies,
  locked: LockedWorkspaceSecurityActor,
): Promise<void> => {
  const method = locked.evidence?.method;
  const providers = await accountMethods(transaction, [locked.user.id]);
  const available = availableMethods(
    locked.user,
    providers.get(locked.user.id) ?? new Set(),
    dependencies.signInMethods(),
  );
  if (!Object.entries(available).some(([known, enabled]) => known === method && enabled))
    throw securityNotReady(
      'Sign in through a currently configured independent method before managing policy recovery.',
    );
};

interface WorkspaceRecoveryReadiness {
  readonly ready: boolean;
  readonly revision: string;
  readonly ownerId: string | null;
}

/** One bounded query for native owners/codes and one for their account methods; never one query per owner. */
export const workspaceRecoveryReadiness = async (
  database: Executor,
  dependencies: WorkspacePolicyDependencies,
  workspaceId: string,
): Promise<WorkspaceRecoveryReadiness> => {
  let after: { readonly ownerId: string; readonly revision: string } | undefined;
  for (;;) {
    let query = database
      .selectFrom('workspace_mfa_recovery_codes as code')
      .innerJoin('workspace_members as member', (join) =>
        join
          .onRef('member.workspace_id', '=', 'code.workspace_id')
          .onRef('member.user_id', '=', 'code.user_id'),
      )
      .innerJoin('users as person', 'person.id', 'code.user_id')
      .select([
        'person.id',
        'person.github_id',
        'person.github_login',
        'person.github_connected_at',
        'person.google_made',
        'code.revision',
      ])
      .where('code.workspace_id', '=', workspaceId)
      .where('code.purpose', '=', 'policy')
      .where('code.spent_at', 'is', null)
      .where('code.revoked_at', 'is', null)
      .where('member.role', '=', 'owner')
      .where('member.workspace_id', '=', workspaceId)
      .where('member.access_kind', '=', 'member')
      .where('person.deleted_at', 'is', null)
      .where('person.suspended_at', 'is', null)
      .where('person.admission_state', '=', 'approved')
      .where((expression) =>
        expression.or([
          expression('person.admission_requires_verified_email', '=', false),
          expression('person.email_verified', '=', true),
        ]),
      )
      .orderBy('person.id')
      .orderBy('code.revision')
      .limit(100);
    if (after !== undefined) {
      const cursor = after;
      query = query.where((expression) =>
        expression.or([
          expression('person.id', '>', cursor.ownerId),
          expression.and([
            expression('person.id', '=', cursor.ownerId),
            expression('code.revision', '>', cursor.revision),
          ]),
        ]),
      );
    }
    const owners = await query.execute();
    const accounts = await accountMethods(
      database,
      owners.map((person) => person.id),
    );
    const enabled = dependencies.signInMethods();
    const owner = owners.find((person) =>
      Object.values(availableMethods(person, accounts.get(person.id) ?? new Set(), enabled)).some(
        Boolean,
      ),
    );
    if (owner !== undefined) return { ready: true, revision: owner.revision, ownerId: owner.id };
    const last = owners.at(-1);
    if (owners.length < 100 || last === undefined)
      return { ready: false, revision: NO_POLICY_RECOVERY_REVISION, ownerId: null };
    after = { ownerId: last.id, revision: last.revision };
  }
};

export const policyRecoveryDigest = async (
  workspaceId: string,
  userId: string,
  revision: string,
  code: string,
): Promise<Buffer> =>
  Buffer.from(
    await tokenDigest(
      `purlay:workspace-policy-recovery:v1:${workspaceId}:${userId}:${revision.toLowerCase()}:${code}`,
    ),
    'hex',
  );

export const lockOwnPolicyRecoveryRows = async (
  transaction: Transaction,
  locked: LockedWorkspaceSecurityActor,
): Promise<void> => {
  await transaction
    .selectFrom('workspace_mfa_recovery_codes')
    .select('id')
    .where('workspace_id', '=', locked.context.workspaceId)
    .where('user_id', '=', locked.context.userId)
    .where('purpose', '=', 'policy')
    .orderBy('id')
    .forUpdate()
    .execute();
};

export const ownPolicyRecoveryRevision = async (
  transaction: Transaction,
  workspaceId: string,
  userId: string,
): Promise<string> =>
  (
    await transaction
      .selectFrom('workspace_mfa_recovery_codes')
      .select('revision')
      .where('workspace_id', '=', workspaceId)
      .where('user_id', '=', userId)
      .where('purpose', '=', 'policy')
      .where('spent_at', 'is', null)
      .where('revoked_at', 'is', null)
      .orderBy('revision')
      .executeTakeFirst()
  )?.revision ?? NO_POLICY_RECOVERY_REVISION;
