/**
 * The wizard's screens, in the order they are walked, and which of the contract's steps each one
 * passes. `SETUP_STEPS` has nine — the address and the policy are two steps for the server and one
 * screen for the person (UX §11, step 3) — so the screen is passed when its last step is.
 */
import type { SetupState, SetupStep } from '@purlay/types';
import type { PlainKey } from '../../i18n/types';

export const SCREENS = [
  'claim',
  'admin',
  'address',
  'github',
  'email',
  'workspace',
  'invite',
  'finish',
] as const;

export type Screen = (typeof SCREENS)[number];

/** The step whose being passed is the screen's being done. `claim` is done by holding the setup. */
const PASSES: Record<Screen, SetupStep> = {
  claim: 'claim',
  admin: 'admin',
  address: 'policy',
  github: 'github',
  email: 'email',
  workspace: 'workspace',
  invite: 'invite',
  finish: 'finish',
};

export const NAMES: Record<Screen, { readonly name: PlainKey; readonly line: PlainKey }> = {
  claim: { name: 'setup.step.claim.name', line: 'setup.step.claim.line' },
  admin: { name: 'setup.step.admin.name', line: 'setup.step.admin.line' },
  address: { name: 'setup.step.address.name', line: 'setup.step.address.line' },
  github: { name: 'setup.step.github.name', line: 'setup.step.github.line' },
  email: { name: 'setup.step.email.name', line: 'setup.step.email.line' },
  workspace: { name: 'setup.step.workspace.name', line: 'setup.step.workspace.line' },
  invite: { name: 'setup.step.invite.name', line: 'setup.step.invite.line' },
  finish: { name: 'setup.step.finish.name', line: 'setup.step.finish.line' },
};

/** Whether the server holds this screen as passed. */
export const passed = (state: SetupState | null, screen: Screen): boolean =>
  state?.steps.includes(PASSES[screen]) === true;

/** Where to resume: the first screen not passed; the last one when all are. */
export const resumeAt = (state: SetupState | null): number => {
  const index = SCREENS.findIndex((screen) => !passed(state, screen));
  return index === -1 ? SCREENS.length - 1 : index;
};
