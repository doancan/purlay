/**
 * Driving the product's date field as a person does: open it, turn to the month, press the day.
 *
 * The field is a button and a calendar, not a text box, so a test cannot type a date into it. The
 * label is the field's own; the day is `YYYY-MM-DD`, and the day buttons are named in English long form.
 */
import { expect } from 'bun:test';
import { fireEvent, waitFor, within, type RenderResult } from '@testing-library/react';

type Scope = Pick<RenderResult, 'getByRole'>;

const longDay = (day: string): string =>
  new Intl.DateTimeFormat('en', { dateStyle: 'long', timeZone: 'UTC' }).format(
    new Date(`${day}T00:00:00Z`),
  );

const openField = async (scope: Scope, label: string): Promise<HTMLElement> => {
  fireEvent.click(scope.getByRole('button', { name: new RegExp(`^${label}`) }));
  return await waitFor(() => within(document.body).getByRole('grid'));
};

/** Opens the field named `label`, turns to the month of `day`, and presses it. */
export const pickDay = async (scope: Scope, label: string, day: string): Promise<void> => {
  const grid = await openField(scope, label);
  for (let turns = 0; turns < 120; turns++) {
    const target = within(grid).queryByLabelText(longDay(day));
    if (target !== null && !(target as HTMLButtonElement).disabled) {
      const inMonth = target.textContent === String(Number(day.slice(8)));
      if (inMonth) {
        fireEvent.click(target);
        await waitFor(() => {
          expect(within(document.body).queryByRole('grid')).toBeNull();
        });
        return;
      }
    }
    const first = grid.querySelector<HTMLElement>('[data-day]')?.dataset['day'] ?? day;
    const button = within(document.body).getByRole('button', {
      name: day < first ? 'Previous month' : 'Next month',
    });
    fireEvent.click(button);
  }
  throw new Error(`the calendar never showed ${day}`);
};

/** Opens the field named `label` and clears it. */
export const clearDay = async (scope: Scope, label: string): Promise<void> => {
  await openField(scope, label);
  fireEvent.click(within(document.body).getByRole('button', { name: 'Clear' }));
  await waitFor(() => {
    expect(within(document.body).queryByRole('grid')).toBeNull();
  });
};

/** What the field says its day is, in English long form, or its placeholder when empty. */
export const dayShown = (scope: Scope, label: string): string =>
  scope.getByRole('button', { name: new RegExp(`^${label}`) }).textContent;
