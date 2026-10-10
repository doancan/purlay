/**
 * A person, for tests that type, tab and press keys.
 *
 * `fireEvent` dispatches one event; a person produces a sequence — `keydown`,
 * `beforeinput`, `input`, `keyup`, focus moving, a pointer pressing and
 * releasing — and what React and Radix react to is the sequence. In this test DOM
 * `fireEvent.input` and `fireEvent.change` set a value React never notices (the
 * `onChange` was called 0 times, measured), where `user-event` types the way a
 * keyboard does and the handler runs.
 *
 * **`document` is passed explicitly**: `user-event` otherwise reads it from the
 * module scope, where this test DOM does not exist yet (`testing/dom.ts`). Called
 * per test, so it is the document of the file that is running.
 */
import userEvent from '@testing-library/user-event';

export const person = (): ReturnType<typeof userEvent.setup> => userEvent.setup({ document });
