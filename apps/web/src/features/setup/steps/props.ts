import type { SetupState } from '@purlay/types';
import type { Screen } from '../screens';

/** What every step after the code is given. */
export interface StepProps {
  readonly state: SetupState;
  /** The server holds this screen as passed: the person came back to it. */
  readonly done: boolean;
  /** Back one screen, or null on the first that has one before it. */
  readonly onBack: (() => void) | null;
  /** Forward to the next screen without saving anything (a screen already done). */
  readonly onNext: () => void;
  readonly goTo: (screen: Screen) => void;
}
