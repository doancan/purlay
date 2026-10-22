/**
 * What a password must be, said as the person types it: the policy's rules (`passwordProblem`,
 * `@purlay/types`) read as met, broken or not yet known — never written a second time. The server says
 * them again. Shared by the setup's administrator step and the change-password card.
 */
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, type PasswordProblem } from '@purlay/types';
import { Icon } from '../../components/icon';
import { useI18n } from '../../i18n/i18n-provider';
import type { MessageKey, PlainKey } from '../../i18n/types';
import { cn } from '../../ui/cn';
import { VisuallyHidden } from '../../ui/visually-hidden';

/** One sentence for each problem the policy can name. */
export const PASSWORD_PROBLEMS: Record<PasswordProblem, PlainKey> = {
  'too-short': 'setup.admin.problem.too-short',
  'too-long': 'setup.admin.problem.too-long',
  'invalid-character': 'setup.admin.problem.invalid-character',
  blank: 'setup.admin.problem.blank',
  'contains-email': 'setup.admin.problem.contains-email',
  'contains-name': 'setup.admin.problem.contains-name',
  common: 'setup.admin.problem.common',
  repetitive: 'setup.admin.problem.repetitive',
};

/** The rules, in the order the policy checks them; each is the problems it can raise. */
const RULES = [
  {
    key: 'setup.admin.rule.length',
    problems: ['too-short', 'too-long', 'invalid-character', 'blank'],
  },
  { key: 'setup.admin.rule.own', problems: ['contains-email', 'contains-name'] },
  { key: 'setup.admin.rule.common', problems: ['common'] },
  { key: 'setup.admin.rule.repetitive', problems: ['repetitive'] },
] as const satisfies readonly {
  readonly key: MessageKey;
  readonly problems: readonly PasswordProblem[];
}[];

/** What is known of a rule: not yet, met, or broken. Numbers, so none is read as a class. */
type RuleState = 0 | 1 | 2;
const UNKNOWN = 0;
const MET = 1;
const BROKEN = 2;

const RULE_TONES = ['text-ink-muted', 'text-success-text', 'text-danger-text'] as const;

/** Each rule's state for a password: those before the first broken one are met, those after unknown. */
const ruleStates = (password: string, problem: PasswordProblem | undefined): RuleState[] => {
  if (password === '') return RULES.map(() => UNKNOWN);
  const broken = RULES.findIndex((rule) =>
    problem === undefined ? false : (rule.problems as readonly PasswordProblem[]).includes(problem),
  );
  return RULES.map((_, index) =>
    broken === -1 || index < broken ? MET : index === broken ? BROKEN : UNKNOWN,
  );
};

interface PasswordRulesProps {
  readonly password: string;
  /** What `passwordProblem` said of `password` for its owner. */
  readonly problem: PasswordProblem | undefined;
}

export const PasswordRules = ({ password, problem }: PasswordRulesProps): React.JSX.Element => {
  const { t } = useI18n();
  const states = ruleStates(password, problem);
  return (
    <div className="flex flex-col gap-1">
      <p className="text-caption text-ink-muted">{t('setup.admin.rules')}</p>
      <ul className="flex flex-col gap-1">
        {RULES.map((rule, index) => {
          const state = states[index] ?? UNKNOWN;
          return (
            <li
              key={rule.key}
              className={cn('flex items-center gap-2 text-caption', RULE_TONES[state])}
            >
              <Icon
                name={state === MET ? 'confirm' : state === BROKEN ? 'close' : 'info'}
                size="sm"
              />
              <span>
                {rule.key === 'setup.admin.rule.length'
                  ? t(rule.key, { min: PASSWORD_MIN_LENGTH, max: PASSWORD_MAX_LENGTH })
                  : t(rule.key)}
              </span>
              {state !== UNKNOWN && (
                <VisuallyHidden>
                  {state === MET ? t('setup.admin.rule.met') : t('setup.admin.rule.broken')}
                </VisuallyHidden>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
};
